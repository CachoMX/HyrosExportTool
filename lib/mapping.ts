// Flattens Hyros Sale / Call / Lead records into the flat ExportRow the client wants.

import { AdInfo, Attribution, Call, Click, ExportRow, Lead, Sale } from "./types";

const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

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

/** Build a leads row from the lead + its click history (clicks give the source). */
export function leadToRow(lead: Lead, clicks: Click[], dict: Map<string, AdInfo>): ExportRow {
  const row: ExportRow = blankRow();
  row.email = s(lead.email);
  row.creationDate = s(lead.creationDate);
  row.recordId = s(lead.id);
  row.extra = (lead.tags || []).join(",");

  const sorted = [...clicks].sort((a, b) => new Date(s(a.date)).getTime() - new Date(s(b.date)).getTime());
  const firstClick = sorted[0];
  const lastClick = sorted[sorted.length - 1];
  row.originSource = s(firstClick?.sourceLinkName);
  row.lastSource = s(lastClick?.sourceLinkName);

  const adId = s(lastClick?.adSpendId);
  row.adId = adId;
  row.platform = s(lastClick?.adspendType);
  const info = adId ? dict.get(adId) : undefined;
  if (info) {
    row.campaignName = s(info.campaignName);
    row.campaignId = s(info.campaignId);
    row.adSetName = s(info.adSetName);
    row.adSetId = s(info.adSetId);
    row.adName = s(info.adName);
    if (info.adAccountId) row.adAccountId = info.adAccountId;
  }
  return row;
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
