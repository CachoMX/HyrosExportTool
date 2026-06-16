// Flattens Hyros Sale / Call / Lead records into the flat ExportRow the client wants.

import { AdInfo, Attribution, Call, ExportRow, Lead, LeadJourney, Sale } from "./types";

const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** Parse Hyros dates: ISO ("2026-06-16T10:15:01-04:00") or Java ("Mon Jun 15 20:46:24 UTC 2026"). */
export function parseHyrosDate(v?: string): number {
  if (!v) return 0;
  const t = Date.parse(v);
  if (!isNaN(t)) return t;
  const m = v.match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \w+ (\d{4})$/);
  if (m) {
    const t2 = Date.parse(`${m[1]} ${m[2]} ${m[6]} ${m[3]}:${m[4]}:${m[5]} UTC`);
    if (!isNaN(t2)) return t2;
  }
  return 0;
}

// The real platform ad id lives on sourceLinkAd.adSourceId — verified to be the id
// the /attribution report keys on (adSource.adSourceId does NOT match it).
const adIdOf = (a?: Attribution): string => a?.sourceLinkAd?.adSourceId || a?.adSource?.adSourceId || "";

/** The attribution we use for the campaign/adset/ad columns: prefer the paid lastSource. */
function chooseAdAttr(first?: Attribution, last?: Attribution): Attribution | undefined {
  if (adIdOf(last)) return last;
  if (adIdOf(first)) return first;
  return last || first;
}

/** Distinct (platform, adAccountId) pairs referenced by a set of sale/call records. */
export function collectTargets(records: { firstSource?: Attribution; lastSource?: Attribution }[]): {
  platform: string;
  adAccountId: string;
}[] {
  const map = new Map<string, { platform: string; adAccountId: string }>();
  for (const r of records) {
    for (const attr of [r.firstSource, r.lastSource]) {
      const ad = attr?.adSource;
      if (ad?.adAccountId && ad?.platform) {
        map.set(`${ad.platform}|${ad.adAccountId}`, { platform: ad.platform, adAccountId: ad.adAccountId });
      }
    }
  }
  return [...map.values()];
}

function applyAd(row: ExportRow, attr: Attribution | undefined, dict: Map<string, AdInfo>) {
  const ad = attr?.adSource;
  row.adId = adIdOf(attr); // sourceLinkAd.adSourceId — the real platform ad id
  row.platform = s(ad?.platform);
  row.adAccountId = s(ad?.adAccountId);
  // Direct ad name straight off the record.
  const directAdName = s(attr?.sourceLinkAd?.name);

  const info = row.adId ? dict.get(row.adId) : undefined;
  row.campaignName = s(info?.campaignName);
  row.campaignId = s(info?.campaignId);
  row.adSetName = s(info?.adSetName);
  row.adSetId = s(info?.adSetId);
  row.adName = s(info?.adName) || directAdName || s(attr?.name);
  if (info?.adAccountId && !row.adAccountId) row.adAccountId = info.adAccountId;
  if (info?.platform && !row.platform) row.platform = info.platform;
}

export function saleToRow(sale: Sale, dict: Map<string, AdInfo>): ExportRow {
  const adAttr = chooseAdAttr(sale.firstSource, sale.lastSource);
  const row: ExportRow = blankRow();
  row.email = s(sale.lead?.email);
  row.originSource = s(sale.firstSource?.name);
  row.lastSource = s(sale.lastSource?.name);
  row.creationDate = s(sale.creationDate);
  row.recordId = s(sale.id);
  const rev = sale.price?.price;
  row.extra = [
    sale.orderId ? `order:${sale.orderId}` : "",
    rev !== undefined ? `revenue:${rev}${sale.price?.currency ? " " + sale.price.currency : ""}` : "",
    sale.product?.name ? `product:${sale.product.name}` : "",
    sale.recurring ? "recurring" : "",
  ]
    .filter(Boolean)
    .join(" | ");
  applyAd(row, adAttr, dict);
  return row;
}

export function callToRow(call: Call, dict: Map<string, AdInfo>): ExportRow {
  const adAttr = chooseAdAttr(call.firstSource, call.lastSource);
  const row: ExportRow = blankRow();
  row.email = s(call.lead?.email);
  row.originSource = s(call.firstSource?.name);
  row.lastSource = s(call.lastSource?.name);
  row.creationDate = s(call.creationDate);
  row.recordId = s(call.id);
  row.extra = [call.state ? `state:${call.state}` : "", call.qualified !== undefined ? `qualified:${call.qualified}` : ""]
    .filter(Boolean)
    .join(" | ");
  applyAd(row, adAttr, dict);
  return row;
}

/**
 * Build a leads row from the lead's JOURNEY. A lead's ad attribution lives on its
 * sales/calls/carts (first/last source) — NOT on raw clicks (which are mostly the
 * organic funnel pages). We take the earliest record's firstSource as the origin and
 * the latest record's lastSource as the last source, then enrich the ad columns.
 */
export function leadJourneyToRow(journey: LeadJourney, fallbackLead: Lead | undefined, dict: Map<string, AdInfo>): ExportRow {
  const lead = journey.lead || fallbackLead || {};
  const row: ExportRow = blankRow();
  row.email = s(lead.email);
  row.creationDate = s(lead.creationDate);
  row.recordId = s(lead.id);

  // All attributed touchpoints across the journey, sorted by date.
  const records: { date: number; first?: Attribution; last?: Attribution }[] = [];
  for (const sale of journey.sales || []) records.push({ date: parseHyrosDate(sale.creationDate), first: sale.firstSource, last: sale.lastSource });
  for (const call of journey.calls || []) records.push({ date: parseHyrosDate(call.creationDate), first: call.firstSource, last: call.lastSource });
  for (const cart of journey.carts || []) records.push({ date: parseHyrosDate(cart.creationDate), first: cart.firstSource, last: cart.lastSource });
  records.sort((a, b) => a.date - b.date);

  const originAttr = records.find((r) => r.first?.name || r.first?.sourceLinkAd)?.first;
  const lastWithSource = [...records].reverse().find((r) => r.last?.name || r.last?.sourceLinkAd);
  const lastAttr = lastWithSource?.last;

  row.originSource = s(originAttr?.name);
  row.lastSource = s(lastAttr?.name);

  const adAttr = chooseAdAttr(originAttr, lastAttr);
  applyAd(row, adAttr, dict);

  row.extra = [
    (journey.sales || []).length ? `sales:${(journey.sales || []).length}` : "",
    (journey.calls || []).length ? `calls:${(journey.calls || []).length}` : "",
    (lead.tags || []).length ? `tags:${(lead.tags || []).join(",")}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  return row;
}

/** Distinct (platform, adAccountId) pairs referenced by a set of lead journeys. */
export function collectJourneyTargets(journeys: LeadJourney[]): { platform: string; adAccountId: string }[] {
  const records: { firstSource?: Attribution; lastSource?: Attribution }[] = [];
  for (const j of journeys) {
    for (const sale of j.sales || []) records.push(sale);
    for (const call of j.calls || []) records.push(call);
    for (const cart of j.carts || []) records.push(cart);
  }
  return collectTargets(records);
}

export function blankRow(): ExportRow {
  return {
    email: "",
    originSource: "",
    lastSource: "",
    campaignName: "",
    adSetName: "",
    adName: "",
    adId: "",
    adSetId: "",
    campaignId: "",
    platform: "",
    adAccountId: "",
    creationDate: "",
    recordId: "",
    extra: "",
  };
}
