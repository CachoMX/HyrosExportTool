// Streaming export endpoint. Receives { apiKey, fromDate, toDate, report, enrich }
// and streams NDJSON StreamMessages back to the browser as data is fetched,
// enriched and flattened. Keeps the API key server-side only.

import { NextRequest } from "next/server";
import { HyrosClient, pool } from "@/lib/hyros";
import { buildAdDictionary } from "@/lib/enrich";
import { callToRow, collectTargets, leadToRow, saleToRow } from "@/lib/mapping";
import { AdInfo, Call, Click, EnrichMode, Lead, ReportType, Sale, StreamMessage } from "@/lib/types";

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

  // Enrich each lead's source via its click history (one lookup per lead).
  send({ type: "progress", phase: "Fetching lead sources (clicks)", fetched: 0, detail: `${leads.length} leads` });
  const clicksByLead = new Map<string, Click[]>();
  await pool(
    leads,
    8,
    async (lead) => {
      if (!lead.id) return;
      const acc: Click[] = [];
      try {
        await client.paginate<Click>(
          "/api/v1.0/leads/clicks",
          { leadId: lead.id, fromDate, toDate },
          (items) => {
            acc.push(...items);
          }
        );
      } catch {
        // skip leads whose clicks can't be fetched
      }
      clicksByLead.set(lead.id, acc);
    },
    (done) => {
      if (done % 25 === 0 || done === leads.length)
        send({ type: "progress", phase: "Fetching lead sources (clicks)", fetched: done, total: leads.length });
    }
  );

  // Leads are attributed by click. In practice most lead clicks are organic
  // (no ad source), so the campaign/ad-set hierarchy can't be resolved per lead the
  // way it can for sales/calls. We surface the click-derived source and note the limit.
  const dict = new Map<string, AdInfo>();
  const paidLeads = [...clicksByLead.values()].filter((cl) =>
    cl.some((c) => c.adSpendId != null && c.adSpendId !== "")
  ).length;
  if (enrich === "full") {
    send({
      type: "warn",
      message: `Leads source comes from click history. ${paidLeads}/${leads.length} lead(s) have a paid click; the rest are organic/untracked, so their Campaign/Ad Set/Ad columns are blank. Sales & Calls reports carry full ad attribution.`,
    });
  }

  const CHUNK = 500;
  const rows = leads.map((l) => leadToRow(l, clicksByLead.get(l.id || "") || [], dict));
  for (let i = 0; i < rows.length; i += CHUNK) {
    send({ type: "rows", rows: rows.slice(i, i + CHUNK) });
  }
  send({ type: "done", total: leads.length });
}
