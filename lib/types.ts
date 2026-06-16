// Shared types for the Hyros export tool.
// Mirrors the relevant parts of the Hyros REST API OpenAPI spec (v1.37).

export type ReportType = "sales" | "calls" | "leads";

export type EnrichMode = "full" | "direct" | "parse";

/** AdSource as embedded in attribution objects. */
export interface AdSource {
  adSourceId?: string;
  adAccountId?: string;
  platform?: string; // FACEBOOK | GOOGLE | TIKTOK | SNAPCHAT | LINKEDIN | TWITTER | PINTEREST | BING
}

/** Attribution object embedded in Sale / Call records (firstSource / lastSource). */
export interface Attribution {
  sourceLinkId?: string;
  name?: string;
  tag?: string;
  disregarded?: boolean;
  organic?: boolean;
  clickDate?: string;
  clickId?: string;
  adSource?: AdSource;
  sourceLinkAd?: { name?: string; adSourceId?: string };
  trafficSource?: { id?: string; name?: string };
  goal?: { id?: string; name?: string };
  category?: { id?: string; name?: string };
  gclId?: string;
}

export interface Lead {
  email?: string;
  id?: string;
  creationDate?: string;
  tags?: string[];
  ips?: string[];
  phoneNumbers?: string[];
  firstName?: string;
  lastName?: string;
}

export interface Sale {
  id?: string;
  orderId?: string;
  creationDate?: string;
  qualified?: boolean;
  recurring?: boolean;
  quantity?: number;
  lead?: Lead;
  firstSource?: Attribution;
  lastSource?: Attribution;
  price?: { currency?: string; price?: number; refunded?: number };
  product?: { name?: string };
}

export interface Call {
  id?: string;
  qualified?: boolean;
  name?: string;
  creationDate?: string;
  state?: string;
  lead?: Lead;
  firstSource?: Attribution;
  lastSource?: Attribution;
}

/** A cart inside a lead journey (carries its own attribution). */
export interface Cart {
  id?: string;
  orderId?: string;
  creationDate?: string;
  firstSource?: Attribution;
  lastSource?: Attribution;
}

/** Lead journey from /leads/journey — where a lead's ad attribution actually lives. */
export interface LeadJourney {
  lead?: Lead;
  sales?: Sale[];
  calls?: Call[];
  carts?: Cart[];
}

/** A single Hyros click (from /leads/clicks), used to derive lead source. */
export interface Click {
  id?: string;
  date?: string;
  adspendType?: string;
  sourceLinkName?: string;
  adSpendId?: number | string;
  ip?: string;
}

/**
 * Resolved campaign -> adset -> ad hierarchy for a single ad id.
 * Built from the /attribution report at the platform's ad level.
 */
export interface AdInfo {
  adId?: string;
  adName?: string;
  adSetId?: string;
  adSetName?: string;
  campaignId?: string;
  campaignName?: string;
  platform?: string;
  adAccountId?: string;
}

/** The flat output row — exactly the columns the client requested, plus context. */
export interface ExportRow {
  email: string;
  originSource: string; // firstSource.name
  lastSource: string; // lastSource.name
  campaignName: string;
  adSetName: string;
  adName: string;
  adId: string;
  adSetId: string;
  campaignId: string;
  // Helpful context columns:
  platform: string;
  adAccountId: string;
  creationDate: string;
  recordId: string;
  extra: string; // report-specific (order id / call state / lead tags)
}

export const ROW_HEADERS: { key: keyof ExportRow; label: string }[] = [
  { key: "email", label: "Email" },
  { key: "originSource", label: "Origin Source" },
  { key: "lastSource", label: "Last Source" },
  { key: "campaignName", label: "Campaign Name" },
  { key: "adSetName", label: "Ad Set Name" },
  { key: "adName", label: "Ad Name" },
  { key: "adId", label: "Ad ID" },
  { key: "adSetId", label: "Ad Set ID" },
  { key: "campaignId", label: "Campaign ID" },
  { key: "platform", label: "Platform" },
  { key: "adAccountId", label: "Ad Account ID" },
  { key: "creationDate", label: "Date" },
  { key: "extra", label: "Details" },
  { key: "recordId", label: "Record ID" },
];

/** NDJSON messages streamed from the export endpoint to the browser. */
export type StreamMessage =
  | { type: "progress"; phase: string; fetched: number; total?: number; detail?: string }
  | { type: "rows"; rows: ExportRow[] }
  | { type: "warn"; message: string }
  | { type: "done"; total: number }
  | { type: "error"; message: string };
