// Flattens Hyros Sale / Call / Lead records into the flat ExportRow the client wants.

import { AdInfo, Attribution, Call, ExportRow, Lead, Sale, Source } from "./types";

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

/**
 * Build a leads row from the lead's `@`-prefixed source tags (present in the base
 * /leads response) resolved against the /sources catalog. This is where a lead's
 * source actually lives — ~74-87% coverage, with no per-lead API call. The journey
 * approach only covered the ~2-3% of leads that had converted.
 */
export function leadToRow(lead: Lead, sourceMap: Map<string, Source>, dict: Map<string, AdInfo>): ExportRow {
  const row: ExportRow = blankRow();
  row.email = s(lead.email);
  row.creationDate = s(lead.creationDate);
  row.recordId = s(lead.id);

  const tags = lead.tags || [];
  const atTags = tags.filter((t) => t.startsWith("@"));
  const resolved = atTags.map((t) => sourceMap.get(t)).filter((x): x is Source => !!x);

  if (resolved.length) {
    // Tags aren't time-ordered, so origin/last are approximate for multi-source leads.
    row.originSource = s(resolved[0].name);
    row.lastSource = s(resolved[resolved.length - 1].name);

    // Prefer a paid source (one with an adSource) for the ad columns.
    const adSrc = resolved.find((r) => r.adSource?.adSourceId) || resolved[resolved.length - 1];
    const ad = adSrc.adSource;
    row.adId = s(ad?.adSourceId);
    row.platform = s(ad?.platform);
    row.adAccountId = s(ad?.adAccountId);
    row.adName = s(adSrc.name);

    const info = row.adId ? dict.get(row.adId) : undefined;
    if (info) {
      row.campaignName = s(info.campaignName);
      row.campaignId = s(info.campaignId);
      row.adSetName = s(info.adSetName);
      row.adSetId = s(info.adSetId);
      if (info.adName) row.adName = info.adName;
    }
  }

  const products = tags.filter((t) => t.startsWith("$")).length;
  row.extra = [atTags.length > 1 ? `sources:${atTags.length}` : "", products ? "converted" : ""]
    .filter(Boolean)
    .join(" | ");
  return row;
}

/** Distinct (platform, adAccountId) pairs referenced by a set of sources. */
export function collectSourceTargets(sources: Source[]): { platform: string; adAccountId: string }[] {
  const map = new Map<string, { platform: string; adAccountId: string }>();
  for (const src of sources) {
    const ad = src.adSource;
    if (ad?.adAccountId && ad?.platform) {
      map.set(`${ad.platform}|${ad.adAccountId}`, { platform: ad.platform, adAccountId: ad.adAccountId });
    }
  }
  return [...map.values()];
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
