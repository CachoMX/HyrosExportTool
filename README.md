# Hyros Export Tool

A self-contained Next.js app that exports **Sales**, **Calls** and **Leads** from the
[Hyros REST API](https://api-docs.hyros.com/) — one report at a time — with the per-email
attribution columns a client typically needs:

| Origin Source | Last Source | Campaign Name | Ad Set Name | Ad Name | Ad ID | Ad Set ID | Campaign ID |
|---|---|---|---|---|---|---|---|

The user only enters their **API Key** and a **date range**, picks a report, and clicks
**Generate**. Results stream into a preview table and can be exported to **CSV** or **XLSX**.

---

## Run it

```bash
npm install
npm run dev      # http://localhost:3000   (or: npm run build && npm run start)
```

Open the app, paste your Hyros API Key (Hyros → **Settings → API**), choose the date range
and report, and export.

---

## How it works (API analysis)

Base URL: `https://api.hyros.com/v1` · Auth header: `API-Key: <key>` · Format: JSON.

**Rate limits** (enforced automatically by the app): **30 req/s**, **1000 req/min**. The client
uses a rolling-window limiter, honours `Retry-After` on `429`, and retries `5xx` with backoff.

**Pagination**: every list endpoint takes `pageSize` (max **250**, the app always uses 250) and
returns a `nextPageId`. The app follows `nextPageId` until exhausted.

### Per report

- **Sales** — `GET /api/v1.0/sales?fromDate&toDate`. Each record embeds the `lead` (email) plus
  `firstSource` and `lastSource` attribution objects → **Origin Source** = `firstSource.name`,
  **Last Source** = `lastSource.name`, and ad name / ad id / ad account / platform from
  `lastSource.adSource` + `lastSource.sourceLinkAd`.
- **Calls** — `GET /api/v1.0/calls?fromDate&toDate`. Same attribution shape as sales.
- **Leads** — `GET /api/v1.0/leads?fromDate&toDate` returns **no attribution**, so for each lead
  the app calls `GET /api/v1.0/leads/clicks?leadId=…` and derives Origin Source (first click) and
  Last Source (last click) from the click history (8 concurrent lookups, rate-limited).

### Campaign / Ad Set enrichment (the "Full enrichment" toggle)

The per-record attribution does **not** contain a clean campaign→ad-set→ad hierarchy. That is only
exposed by the aggregate report `GET /api/v1.0/attribution`, queried at the platform's ad level
(`facebook_ad`, `google_ad`, `tiktok_ad`, …) with `isAdAccountId=true`, which paginates every ad in
an account for the date range and returns `id`, `name`, `parent_name` (ad set) and `campaign_id`.

The app:
1. Collects the distinct `(platform, adAccountId)` pairs from the fetched records.
2. Fetches the ad-level attribution report once per ad account and builds a dictionary keyed by ad id.
3. Joins it onto every row to fill **Campaign Name/ID** and **Ad Set Name/ID**.

For **leads**, the click history gives an ad id + platform but not an ad account, so the app first
resolves ad ids via `GET /api/v1.0/ads?adSourceIds=…` to find their ad accounts, then runs the same
enrichment. If an ad id can't be matched to the ads catalog, the campaign/ad-set columns are left
blank for that lead (a warning is shown).

Turn the toggle **off** to skip enrichment and export only the fields each record carries directly
(faster, fewer API calls).

---

## Output columns

`Email, Origin Source, Last Source, Campaign Name, Ad Set Name, Ad Name, Ad ID, Ad Set ID,
Campaign ID, Platform, Ad Account ID, Date, Details, Record ID`

`Details` is report-specific (sales: order id / revenue / product; calls: state / qualified;
leads: tags).

---

## Architecture

```
app/
  page.tsx              UI: form, streaming progress, preview table, CSV/XLSX export
  api/export/route.ts   Streaming NDJSON endpoint — orchestrates fetch → enrich → flatten
lib/
  hyros.ts              Rate-limited client, pagination, bounded-concurrency pool
  enrich.ts             Builds the campaign/ad-set/ad dictionary from /attribution + /ads
  mapping.ts            Flattens Sale/Call/Lead records into the export rows
  clientExport.ts       CSV (no deps) + XLSX (SheetJS) download helpers
  types.ts              Shared types + column definitions
```

The API key is sent only to this app's own server route (so it never hits CORS and is never logged
or stored); all Hyros calls happen server-side.

---

## Notes

- **Security advisories**: `npm audit` flags Next.js advisories that only affect features this app
  doesn't use (image optimizer `remotePatterns`, rewrites, RSC request deserialization) and are only
  resolved by upgrading to Next 16 (a breaking change). Pinned to the latest **Next 14.2.x** patch.
- **Verified against a live account (tested June 2026).** What actually populates depends on how
  complete the ad data is in your Hyros account:
  - **Always reliable** (straight off each sale/call record): Email, Origin Source, Last Source,
    **Ad Name**, **Ad ID** (`sourceLinkAd.adSourceId` — note this is the real platform ad id;
    `adSource.adSourceId` is a different internal id and does **not** match the attribution report).
  - **Reliable via enrichment**: **Ad Set Name** (the ad-level `parent_name`).
  - **Best-effort**: **Ad Set ID** — resolved by joining the ad's ad-set *name* to the ad-set-level
    report (Hyros doesn't return the ad-set id on the ad row). Fills when the names line up; blank
    otherwise.
  - **Only if your account syncs it**: **Campaign Name / Campaign ID**. The test account did not sync
    Facebook campaign data, so the campaign-level report was empty and those columns stayed blank
    (the app emits a warning when this happens). Accounts with campaign sync will populate them.
- For **leads**, source is derived from click history; in the test account ~0% of leads had a paid
  click (the rest organic), so lead ad columns are typically blank — sales & calls are where the
  attribution lives.
- The `/attribution` rows are loosely typed; `lib/enrich.ts` matches fields defensively. The join
  key (`sourceLinkAd.adSourceId`) and the name-based ad→ad-set→campaign join live in `lib/enrich.ts`
  + `lib/mapping.ts` if you need to adapt them to another account's structure.
