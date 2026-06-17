// Streaming export endpoint. Receives { apiKey, fromDate, toDate, report, enrich }
// and streams NDJSON StreamMessages back to the browser as data is fetched,
// enriched and flattened. Keeps the API key server-side only.

import { NextRequest } from "next/server";
import { HyrosClient } from "@/lib/hyros";
import { buildAdDictionary, fetchSourceMap } from "@/lib/enrich";
import { callToRow, collectSourceTargets, collectTargets, leadToRow, saleToRow } from "@/lib/mapping";
import { AdInfo, Call, EnrichMode, Lead, ReportType, Sale, Source, StreamMessage } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

interface Body {
  apiKey: string;
  fromDate: string; // ISO 8601
  toDate: string; // ISO 8601
  report: ReportType;
  enrich: EnrichMode;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const { apiKey, fromDate, toDate, report, enrich } = body || ({} as Body);
  if (!apiKey || !fromDate || !toDate || !report) {
    return new Response("Missing apiKey, fromDate, toDate or report", { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (m: StreamMessage) => controller.enqueue(encoder.encode(JSON.stringify(m) + "\n"));
      const client = new HyrosClient(apiKey);
      try {
        if (report === "sales") await runSalesOrCalls(client, "sales", fromDate, toDate, enrich, send);
        else if (report === "calls") await runSalesOrCalls(client, "calls", fromDate, toDate, enrich, send);
        else if (report === "leads") await runLeads(client, fromDate, toDate, enrich, send);
        else send({ type: "error", message: `Unknown report "${report}"` });
      } catch (e: any) {
        send({ type: "error", message: e?.message || String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

async function runSalesOrCalls(
  client: HyrosClient,
  report: "sales" | "calls",
  fromDate: string,
  toDate: string,
  enrich: EnrichMode,
  send: (m: StreamMessage) => void
) {
  const path = report === "sales" ? "/api/v1.0/sales" : "/api/v1.0/calls";
  send({ type: "progress", phase: `Fetching ${report}`, fetched: 0 });

  const records: (Sale | Call)[] = [];
  await client.paginate<Sale | Call>(path, { fromDate, toDate }, (items, fetched) => {
    records.push(...items);
    send({ type: "progress", phase: `Fetching ${report}`, fetched });
  });

  let dict = new Map<string, AdInfo>();
  if (enrich === "full" && records.length) {
    const targets = collectTargets(records as any);
    send({
      type: "progress",
      phase: "Enriching campaigns/ad sets",
      fetched: 0,
      detail: `${targets.length} ad account(s)`,
    });
    const { byAdId, warnings } = await buildAdDictionary(client, targets, fromDate, toDate, (detail, fetched) =>
      send({ type: "progress", phase: "Enriching campaigns/ad sets", fetched, detail })
    );
    dict = byAdId;
    warnings.forEach((w) => send({ type: "warn", message: w }));
  }

  const toRow = report === "sales" ? (r: any) => saleToRow(r, dict) : (r: any) => callToRow(r, dict);
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    send({ type: "rows", rows: records.slice(i, i + CHUNK).map(toRow) });
  }
  send({ type: "done", total: records.length });
}

async function runLeads(
  client: HyrosClient,
  fromDate: string,
  toDate: string,
  enrich: EnrichMode,
  send: (m: StreamMessage) => void
) {
  send({ type: "progress", phase: "Fetching leads", fetched: 0 });
  const leads: Lead[] = [];
  await client.paginate<Lead>("/api/v1.0/leads", { fromDate, toDate }, (items, fetched) => {
    leads.push(...items);
    send({ type: "progress", phase: "Fetching leads", fetched });
  });

  // A lead's source lives in its `@`-prefixed tags (already in the base response),
  // which map to the /sources catalog. We fetch that catalog once (no per-lead calls)
  // and resolve each lead's source from its tags — ~74-87% coverage and scales to 160k.
  send({ type: "progress", phase: "Fetching source catalog", fetched: 0 });
  const sourceMap = await fetchSourceMap(client, (fetched) =>
    send({ type: "progress", phase: "Fetching source catalog", fetched })
  );

  // Full enrichment: same campaign/ad-set dictionary as sales/calls, built from the
  // ad accounts referenced by the sources the leads actually use.
  let dict = new Map<string, AdInfo>();
  if (enrich === "full") {
    const usedTags = new Set<string>();
    for (const l of leads) for (const t of l.tags || []) if (t.startsWith("@")) usedTags.add(t);
    const usedSources: Source[] = [];
    for (const t of usedTags) {
      const src = sourceMap.get(t);
      if (src) usedSources.push(src);
    }
    const targets = collectSourceTargets(usedSources);
    if (targets.length) {
      send({ type: "progress", phase: "Enriching campaigns/ad sets", fetched: 0, detail: `${targets.length} ad account(s)` });
      const { byAdId, warnings } = await buildAdDictionary(client, targets, fromDate, toDate, (detail, fetched) =>
        send({ type: "progress", phase: "Enriching campaigns/ad sets", fetched, detail })
      );
      dict = byAdId;
      warnings.forEach((w) => send({ type: "warn", message: w }));
    }
  }

  const rows = leads.map((l) => leadToRow(l, sourceMap, dict));
  const withSource = rows.filter((r) => r.originSource || r.lastSource).length;

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    send({ type: "rows", rows: rows.slice(i, i + CHUNK) });
  }
  send({
    type: "warn",
    message: `${withSource}/${leads.length} lead(s) resolved to a source (from their @ source tags). Leads with none have no source tag in Hyros (organic/untracked or a deleted source).`,
  });
  send({ type: "done", total: leads.length });
}
