// Builds a campaign -> adset -> ad lookup dictionary from the Hyros /attribution report.
//
// Verified against a live account: per-record attribution on sales/calls carries
// `sourceLinkAd.adSourceId` (the real platform ad id) and `sourceLinkAd.name`.
// The campaign/adset hierarchy is only in the aggregate /attribution report, which
// returns one dimension per call:
//   - level=<platform>_ad      -> { id: adId,    name: adName,   parent_name: adSetName }
//   - level=<platform>_adset   -> { id: adSetId, name: adSetName, parent_name: campaignName? }
//   - level=<platform>_campaign-> { id: campId,  name: campaignName }
// We fetch all three (per ad account, isAdAccountId=true) and join: ad.parent_name
// (ad set name) -> adset.id, then adset.parent_name (campaign name) -> campaign.id.
// The join is by name because the ad-level rows don't carry the parent ad set id.
// Whatever a given account doesn't expose (e.g. campaign sync missing) is left blank.

import { HyrosClient } from "./hyros";
import { AdInfo, Source } from "./types";

/**
 * Fetch the full /sources catalog once and index it by tag. A lead's `@`-prefixed
 * tag (in the base /leads response) matches a source's `tag`, which gives the source
 * name + adSource — this is how ~74-87% of leads get a source without any per-lead call.
 */
export async function fetchSourceMap(
  client: HyrosClient,
  onProgress?: (fetched: number) => void
): Promise<Map<string, Source>> {
  const byTag = new Map<string, Source>();
  await client.paginate<Source>("/api/v1.0/sources", {}, (rows, fetched) => {
    for (const s of rows) if (s.tag) byTag.set(s.tag, s);
    onProgress?.(fetched);
  });
  return byTag;
}

interface Levels {
  ad: string | null;
  adset: string | null;
  campaign: string | null;
}

function levelsFor(platform: string): Levels {
  switch ((platform || "").toUpperCase()) {
    case "FACEBOOK":
      return { ad: "facebook_ad", adset: "facebook_adset", campaign: "facebook_campaign" };
    case "GOOGLE":
      return { ad: "google_ad", adset: "google_v2_adgroup", campaign: "google_campaign" };
    case "TIKTOK":
      return { ad: "tiktok_ad", adset: "tiktok_adgroup", campaign: null };
    case "SNAPCHAT":
      return { ad: "snapchat_ad", adset: "snapchat_adsquad", campaign: null };
    case "PINTEREST":
      return { ad: "pinterest_ad", adset: "pinterest_adgroup", campaign: null };
    case "BING":
      return { ad: "bing_ad", adset: "bing_adgroup", campaign: null };
    case "TWITTER":
      return { ad: null, adset: "twitter_adgroup", campaign: null };
    case "LINKEDIN":
      return { ad: null, adset: null, campaign: "linkedin_campaign" };
    default:
      return { ad: null, adset: null, campaign: null };
  }
}

const norm = (v: unknown) => (v == null ? "" : String(v).trim());

async function fetchLevel(
  client: HyrosClient,
  level: string,
  adAccountId: string,
  startDate: string,
  endDate: string,
  onRow: (row: Record<string, any>) => void,
  onProgress?: (n: number) => void
) {
  let n = 0;
  await client.paginate<Record<string, any>>(
    "/api/v1.0/attribution",
    {
      attributionModel: "last_click",
      startDate,
      endDate,
      level,
      fields: "name,parent_name,sales",
      ids: adAccountId,
      isAdAccountId: true,
      timeGroupingOption: "source_link",
    },
    (rows) => {
      for (const r of rows) onRow(r);
      n += rows.length;
      onProgress?.(n);
    }
  );
}

export interface EnrichResult {
  byAdId: Map<string, AdInfo>;
  warnings: string[];
}

export async function buildAdDictionary(
  client: HyrosClient,
  targets: { platform: string; adAccountId: string }[],
  startDate: string,
  endDate: string,
  onProgress?: (detail: string, fetched: number) => void
): Promise<EnrichResult> {
  const byAdId = new Map<string, AdInfo>();
  const warnings: string[] = [];

  // De-duplicate (platform, adAccount) pairs.
  const seen = new Set<string>();
  const uniq = targets.filter((t) => {
    const k = `${t.platform}|${t.adAccountId}`;
    if (!t.adAccountId || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (const { platform, adAccountId } of uniq) {
    const lv = levelsFor(platform);
    if (!lv.ad) {
      warnings.push(`${platform} has no ad-level attribution — campaign/ad set enrichment skipped for account ${adAccountId}.`);
      continue;
    }
    try {
      // adset level: name -> id, and name -> campaign name (parent_name, if synced)
      const adSetIdByName = new Map<string, string>();
      const campaignNameByAdSetName = new Map<string, string>();
      if (lv.adset) {
        await fetchLevel(client, lv.adset, adAccountId, startDate, endDate, (r) => {
          const name = norm(r.name);
          if (name) {
            if (norm(r.id)) adSetIdByName.set(name, norm(r.id));
            if (norm(r.parent_name)) campaignNameByAdSetName.set(name, norm(r.parent_name));
          }
        });
      }

      // campaign level: name -> id
      const campaignIdByName = new Map<string, string>();
      if (lv.campaign) {
        await fetchLevel(client, lv.campaign, adAccountId, startDate, endDate, (r) => {
          const name = norm(r.name);
          if (name && norm(r.id)) campaignIdByName.set(name, norm(r.id));
        });
      }

      // ad level: the rows we key the dictionary on.
      let count = 0;
      await fetchLevel(
        client,
        lv.ad,
        adAccountId,
        startDate,
        endDate,
        (r) => {
          const adId = norm(r.id);
          if (!adId) return;
          const adSetName = norm(r.parent_name);
          const campaignName = campaignNameByAdSetName.get(adSetName) || "";
          byAdId.set(adId, {
            adId,
            adName: norm(r.name),
            adSetName,
            adSetId: adSetIdByName.get(adSetName) || "",
            campaignName,
            campaignId: campaignName ? campaignIdByName.get(campaignName) || "" : "",
            platform,
            adAccountId,
          });
        },
        (n) => {
          count = n;
          onProgress?.(`${platform} / ${adAccountId}`, n);
        }
      );

      if (lv.campaign && campaignIdByName.size === 0 && count > 0) {
        warnings.push(`${platform} account ${adAccountId}: no campaign-level data returned — Campaign Name/ID columns will be blank (ad & ad-set data is present).`);
      }
    } catch (e: any) {
      warnings.push(`Enrichment failed for ${platform} account ${adAccountId}: ${e?.message || e}`);
    }
  }

  return { byAdId, warnings };
}
