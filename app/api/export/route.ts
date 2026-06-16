// Streaming export endpoint. Receives { apiKey, fromDate, toDate, report, enrich }
// and streams NDJSON StreamMessages back to the browser as data is fetched,
// enriched and flattened. Keeps the API key server-side only.

import { NextRequest } from "next/server";
import { HyrosClient, pool } from "@/lib/hyros";
import { buildAdDictionary } from "@/lib/enrich";
import { callToRow, collectJourneyTargets, collectTargets, leadJourneyToRow, saleToRow } from "@/lib/mapping";
import { AdInfo, Call, EnrichMode, Lead, LeadJourney, ReportType, Sale, StreamMessage } from "@/lib/types";

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

  // A lead's ad attribution lives on its sales/calls/carts (first/last source), NOT on
  // raw clicks (which are mostly organic funnel pages). Pull each lead's journey in
  // batches and derive the source from there — same attribution sales & calls carry.
  send({ type: "progress", phase: "Fetching lead journeys", fetched: 0, total: leads.length });
  const ids = leads.map((l) => l.id).filter((x): x is string => !!x);
  const BATCH = 20;
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));

  const journeys: LeadJourney[] = [];
  await pool(
    batches,
    6,
    async (batch) => {
      try {
        const resp = await client.request<LeadJourney[]>("/api/v1.0/leads/journey", { ids: batch.join(",") });
        if (resp.result) journeys.push(...resp.result);
      } catch {
        // skip a failed batch rather than aborting the whole export
      }
    },
    (done) => send({ type: "progress", phase: "Fetching lead journeys", fetched: Math.min(done * BATCH, leads.length), total: leads.length })
  );

  // Full enrichment: same campaign/ad-set dictionary as sales/calls, built from the
  // ad accounts referenced by the leads' journey sources.
  let dict = new Map<string, AdInfo>();
  if (enrich === "full") {
    const targets = collectJourneyTargets(journeys);
    if (targets.length) {
      send({ type: "progress", phase: "Enriching campaigns/ad sets", fetched: 0, detail: `${targets.length} ad account(s)` });
      const { byAdId, warnings } = await buildAdDictionary(client, targets, fromDate, toDate, (detail, fetched) =>
        send({ type: "progress", phase: "Enriching campaigns/ad sets", fetched, detail })
      );
      dict = byAdId;
      warnings.forEach((w) => send({ type: "warn", message: w }));
    }
  }

  const jByLead = new Map<string, LeadJourney>();
  for (const j of journeys) if (j.lead?.id) jByLead.set(j.lead.id, j);

  const rows = leads.map((l) => leadJourneyToRow(jByLead.get(l.id || "") || { lead: l }, l, dict));
  const withSource = rows.filter((r) => r.originSource || r.lastSource).length;

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    send({ type: "rows", rows: rows.slice(i, i + CHUNK) });
  }
  send({
    type: "warn",
    message: `${withSource}/${leads.length} lead(s) have ad attribution (resolved from their sales/calls/carts). Leads with none have not converted yet, so Hyros does not expose an ad source for them via the API.`,
  });
  send({ type: "done", total: leads.length });
}
