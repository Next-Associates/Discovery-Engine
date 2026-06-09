# Phase 2c — Unified Asset Discovery (merged spec, single source of truth)

**Status:** Spec / proposed — merged from the Phase2c draft + the "Unified Asset Discovery API" plan, with corrections applied. Supersedes both.
**Date:** 2026-06-08
**Follows:** `Phase2_Merged_Plan.md`, `DiscoveryEngine_API_Endpoint_Reference.md`
**Systems:** Discovery-Engine "Vane" (`/Users/mac/NEXTECH/Discovery-Engine`) + OCTO01 (`/Users/mac/NEXTECH/software/OCTO/OCTO01`)

> **Goal:** extend `POST /api/asset-discovery` with a **domain-agnostic `datasets[]` contract** (structured fields + per-dataset `context` evidence), requirement-scoped **latest-version** selection (lossless), cross-source **dedup**, and **regex-first / LLM-fallback** synthesis on cleaned scraped content — so OCTO01 becomes a thin mapper/validator/downloader. Marineregions/EEZ is a **validation example only**, never a hard-coded case.

---

## 0. Current code state (verified 2026-06-08 — important)

`src/app/api/asset-discovery/route.ts` **already** returns two structured, URL-deduped buckets:
- `verified_downloads[]` — passed a live HTTP-200 check.
- `interaction_required_downloads[]` — reachable but gated (e.g. marineregions `download_file.php?name=…`), parsed from the `## Downloads requiring user interaction` section that `scrapeURL.ts` now emits.

So **URLs are no longer dropped** by an HTTP-200 gate (the earlier concern is resolved). What's still missing — and what this spec adds — is the layer *above* those flat lists: **dataset grouping, latest-version selection, requirement filtering, per-dataset `context`, and a clean `datasets[]` contract.** Today that structured body only exists as a markdown code block inside chat `message` prose (see reference chat `b45e5844`), which OCTO01 correctly ignores — so it's lost.

---

## 1. Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Where the clean body comes from | **Evolve `POST /api/asset-discovery`** (single machine contract). `/api/chat` (UI) and `/api/search` stay untouched. Chat UI may call the same synthesizer internally later. |
| D2 | Division of labor | **Vane discovers + structures; OCTO01 maps + validates + downloads + geo-extracts + stores** (OCTO01 keeps the pyshp/shapely/pdf stack). |
| D3 | URLs that fail live HTTP-200 | **Keep, never drop.** Already bucketed as `interaction_required_downloads`; in `datasets[]` carried as assets with `retrieval: "interaction_required"`. |
| D4 | Many versions (v1–v12) | **Latest as primary (`is_latest`) + keep older in `superseded_versions[]` (LOSSLESS).** `discarded[]` is only for true junk (navigation, requirement-mismatch, duplicate URL) — never for superseded versions. |
| D5 | Anti-hallucination | **Universal grounding guard:** every emitted URL **must** appear verbatim in some scraped source's content (not just in the optional LLM pass). Grounding-drops logged to `warnings[]`. `message` is hint-only. |
| D6 | Sync vs async | **Sync-first** (single-dataset ≈ 67s observed). Add **async job + poll** only if `maxSources`-wide LLM synthesis approaches Vane's per-mode timeout (90/180/300s). Response contract identical either way. |
| D7 | Generalization | **Non-negotiable domain-agnostic** (see §2). Tests must include ≥1 non-EEZ publisher. |

---

## 2. Domain-agnostic design rules (non-negotiable)

- **No publisher-specific branches** — no `if marineregions.org`, no EEZ-only field names, no static URL lists.
- **Generic signals only** — URL patterns (`/downloads`, `/releases`), version/date tokens in labels/URLs (`v12`, `2023-10-25`, `release-2.1.0`), trust scores, requirement keyword overlap, existing `isAssetLikeUrl` / `assetPipeline.ts` patterns.
- **Dynamic schema** — `metadata` is an **open object**; known fields (`release_date`, `provider`, …) populated when parseable, omitted when not. No fixed MR-only keys (e.g. `known_issues_reference` lives in `metadata` when present).
- **One validation fixture is not the template** — MR/EEZ is *one* example; the suite must include an unrelated publisher (Zenodo record, GitHub release, or a `.gov` data portal).

---

## 3. Unified response schema (target contract)

Extend the `/api/asset-discovery` response (keeps existing fields for backward compat):

```typescript
{
  message: string;                          // prose answer — HINT ONLY (unchanged)
  sources: Chunk[];                          // raw ground truth (kept for audit)
  verified_downloads: StructuredDownload[];          // backward compat (existing)
  interaction_required_downloads: StructuredDownload[]; // backward compat (existing)

  // NEW — primary OCTO01 input (domain-agnostic; fields populated dynamically)
  datasets: Array<{
    dataset_id: string;                      // stable slug from name + version/date tokens
    dataset_name: string;
    full_title?: string;
    version?: string;                        // parsed token when present (v12, 2.1.0, 2023-10-25)
    is_latest: boolean;
    release_date?: string;                   // ISO when parseable from any publisher format
    provider?: string;
    source_urls: string[];                   // catalog/docs pages scraped (any domain)
    description?: string;
    file_size?: string;
    metadata?: Record<string, unknown>;      // OPEN bag: methodology refs, features, portal ids, …
    selection_reason: string;                // human-readable why this dataset/version was kept
    context: string;                         // cleaned retrieved excerpts evidencing this entry
    context_sources?: Array<{ url: string; title?: string; excerpt_chars?: number }>;
    assets: Array<{
      label: string;
      url: string;
      format?: string;                       // inferred from URL/label (gpkg, shp, pdf, zip, …)
      retrieval: "direct" | "interaction_required";
      http_status: number | null;            // null when unverified/gated
      found_in_source: true;                 // grounding guard passed (D5)
      source_page?: string;
    }>;
    superseded_versions?: Array<{            // D4 — LOSSLESS: older versions kept, not discarded
      version?: string;
      release_date?: string;
      assets: Array</* same asset shape */ object>;
    }>;
  }>;

  // OPEN ESCAPE HATCH — a page that IS the data (not a file catalog): structured extract inline
  data_pages?: Array<{ url: string; title?: string; extracted: Record<string, unknown> }>;

  discarded?: Array<{                        // transparency only — NEVER superseded versions (D4)
    dataset_name: string;
    reason: "requirement_mismatch" | "duplicate_url" | "navigation";
  }>;

  warnings?: string[];                       // e.g. grounding-drops, ambiguous grouping
}
```

Why this generalizes the reference chat's middle JSON:
- `assets[]` replaces a fixed `download_links` object → any number of formats, any publisher.
- `context` carries the retrieved body alongside the JSON → OCTO sidecars, human review, re-extraction without re-scrape.
- `metadata` stays open → nothing publisher-specific is baked in.

---

## 4. Internal pipeline (Vane)

Runs the existing search agent **unchanged**, then post-processes (same hook point as today's `parseVerifiedDownloads`). Regex-first; LLM only when grouping is ambiguous (keeps cost/latency down).

```
[1] Search + scrape top-N sources           (existing researcher path; reuse scrapeURL.ts)
      │                                       (+ research-reliability prerequisite, §6)
[2] Collect candidates from sources[]
      parse ## Verified download links + ## Downloads requiring user interaction
      + catalog prose lines (name/date/size) from cleaned content
      │
[3] Group into product lines (GENERIC signals)
      version/date tokens in url/filename/label; shared host + normalized product prefix
      (token overlap — NOT domain allowlists)
      │
[4] Requirement filter
      intent from query + optional requirements[]: latest/recent, named product,
      seed-url domain, keyword overlap → keep matches; unrelated rows → discarded[mismatch]
      │
[5] Latest-version select (LOSSLESS — D4)
      within each product line compare semver/date tokens; newest → is_latest;
      others → superseded_versions[]  (NOT discarded)
      │
[6] Dedupe assets by normalized URL across sources  (reuse compareSourceTrust / getSourceTrustScore)
      │
[7] Build context per dataset
      concat cleaned excerpts from contributing sources (extractor bullets + link sections +
      matching catalog lines); cap ~12–16k chars; attribute via context_sources
      │
[8] Grounding guard (D5)
      drop any asset.url not present verbatim in source content → warnings[]
      │
[9] Optional synthesizer LLM pass (only when [3] ambiguous)
      input: requirement + parsed link sections + catalog excerpts (chunked ~4–8k)
      output: strict JSON matching datasets[]; URLs/facts must exist in input → re-run [8]
      │
[10] Return: datasets[] + data_pages[] + discarded[] + warnings[] + backward-compat fields
```

### Reusable Vane building blocks (verified to exist)
- `src/app/api/asset-discovery/route.ts` — `parseVerifiedDownloads`, `parseInteractionRequiredDownloads`, `collectStructuredDownloads` (extend, don't replace).
- `src/lib/agents/search/researcher/actions/scrapeURL.ts` — scrape + emits the `## Verified` / `## Downloads requiring user interaction` / `## Catalog` / `## Source pages` sections.
- `src/lib/utils/extractLinks.ts` — `isAssetLikeUrl`, `extractLinksFromHtml`, `normalizeScrapeTargets`, `formatVerifiedLinksSection`, `formatInteractionRequiredLinksSection`.
- `src/lib/utils/verifyUrls.ts` — `verifyDownloadUrls` (HEAD→GET, supports `referer`).
- `src/lib/utils/trustedSources.ts` — `compareSourceTrust`, `getSourceTrustScore`.
- `src/lib/utils/assetPipeline.ts` — existing asset-intent patterns.

### Request body (additive, optional fields)
```typescript
interface AssetDiscoveryRequestBody {
  // existing: query, sources, optimizationMode, chatModel, embeddingModel, history, systemInstructions
  requirements?: string[];   // OCTO requirement texts → drives requirement filter [4]
  seedUrls?: string[];       // wired into systemInstructions seed (like the chat's marineregions.org)
  maxSources?: number;       // default 10
  latestOnly?: boolean;      // default true when query matches /latest|recent|current/i
}
```

---

## 5. HTML/PHP data-page handling (user point #3)

Do **not** download landing pages as `.html`/`.php` files. Per source:
- **asset host** → emit `assets[]` (URL + metadata + `retrieval`). OCTO downloads the file.
- **data page** (the page *is* the data: tables/specs/methodology) → clean + chunk + LLM-extract into `data_pages[].extracted` (structured JSON). Page not saved as a file.
- **navigation** → `discarded[reason: "navigation"]`.

Evidence text for a kept dataset goes in `datasets[].context`; structured data pulled *from* a data page goes in `data_pages[].extracted`. (Keep both — they serve different needs.)

---

## 6. Research reliability (prerequisite — separate from synthesis)

Synthesis has nothing to parse if the agent skips the publisher catalog. Add a **domain-agnostic mandatory catalog scrape**: when asset intent is detected (existing `assetPipeline.ts` / `queryRequestsAssets`-style signals), force a scrape of the top trusted search hits / seed-url catalog pages before synthesis. Implement in `src/lib/agents/search/researcher/index.ts` or `assetPipeline.ts`. Without this, API runs are inconsistent.

---

## 7. OCTO01 changes (thin consumer)

- `backend/asset_discovery/services/discovery_client.py` — parse `datasets[]` into a new `DiscoveryResult.datasets` model; send `requirements[]` + `seedUrls[]` + `maxSources` in the request.
- `backend/asset_discovery/services/orchestrator.py` — **when `datasets[]` non-empty, skip `AssetExtractor.extract` entirely**; map `datasets[].assets[]` → `CandidateAsset` (release_date, provider, format, `retrieval`, `source_page`); persist `context` + `metadata` in sidecars / `discovery_responses` (no re-scrape for review).
- **Keep:** validator + downloader (download only real file URLs; no raw-HTML download for extraction) + `extractors/*` (shapefile→7 JSON) + SQLite.
- **Retire / fallback:** OCTO-side `asset_extractor.py`, `dedup_conflict.py`, `trust_ranker.py` for the 2c path (Vane now owns these). If `datasets[]` empty → fall back to current AssetExtractor path (backward compat). Keep `/api/search` adapter documented as fallback (merged-plan §4).
- This also removes OCTO's silent JSON-parse loss and version duplication (they move to Vane / disappear).

---

## 8. Tasks

| id | task | notes |
|---|---|---|
| `schema-contract` | Define domain-agnostic `datasets[]` + `data_pages[]` + `discarded[]` types; extend response schema | §3 |
| `asset-synthesizer` | `src/lib/utils/assetSynthesizer.ts`: collect → group → requirement filter → **lossless** latest-select → dedupe → context → grounding guard → optional chunked LLM | §4, applies D4+D5 |
| `research-reliability` | Domain-agnostic mandatory catalog scrape on asset intent | §6 (prerequisite) |
| `route-integration` | Wire synthesizer into `asset-discovery/route.ts`; add `requirements[]`, `seedUrls[]`, `maxSources`, `latestOnly` | §4 |
| `parser-tests` | Extend `scripts/test-asset-discovery-parser.ts`: grouping, requirement filter, dedupe, **superseded retained**, grounding, schema; **2 fixtures (MR + non-MR)** | §2, D7 |
| `octo-client` | OCTO: parse `datasets[]` in `discovery_client` + models; send requirements/seedUrls | §7 |
| `octo-orchestrator` | OCTO: skip `AssetExtractor` when `datasets[]` present; map to `CandidateAsset` + persist `context`; keep validator/downloader | §7 |
| `latency-guard` | Measure synthesis time at `maxSources=10`; if near timeout, add async job+poll (D6) | §1 D6 |
| `e2e-verify` | E2E: EEZ as one case **and** a second unrelated publisher; assert no drop, no version dup | D7 |

---

## 9. Milestones (run, inspect real response, write verification note, fix before next)

1. **Schema + route plumbing** — accept `requirements[]`/`seedUrls[]`/`maxSources`; return raw candidates (no grouping). Curl-prove shape.
2. **Synthesizer grouping + requirement filter + lossless latest-select** — curl-prove on MR: one `is_latest` v12 dataset, v1–v11 in `superseded_versions`, real `download_file.php` URLs with `retrieval: "interaction_required"`, `found_in_source: true`.
3. **Dedup + context + grounding guard** — no duplicate URLs across overlapping pages; `context` populated + traceable; grounding-drops in `warnings[]`.
4. **Data-page extraction (§5)** — a methodology/PHP page yields `data_pages[].extracted`, not a saved file.
5. **Research-reliability prerequisite (§6)** — confirm catalog page is always scraped on asset intent.
6. **OCTO adapter (§7)** — Vane `datasets[]` → OCTO maps + downloads + shapefile→7 JSON → SQLite; compare vs prior live run (no dropped URLs, no version dup).
7. **Generalization gate (D7)** — second unrelated publisher; identical response shape.
8. **Latency/async decision (D6)** if timeouts demand it.

---

## 10. Success criteria

**EEZ/MR (one validation case):** 1 latest dataset (not older/unrelated rows) · N format assets under it (not 50+ flat URLs) · `context` stored in OCTO sidecar · no duplicate assets across overlapping pages · older versions present in `superseded_versions`.

**General (any publisher):** response shape identical regardless of domain · `datasets[]` empty only when no asset intent or no scrape success (never because a publisher is "unsupported") · full raw Vane response still persisted for audit.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| LLM synthesis cost/latency in Vane | Regex-first; LLM only when ambiguous; `maxSources` cap; sync-first then async (D6). |
| Version detection is semantic | Generic semver/date tokens + LLM fallback; `superseded_versions` makes mistakes non-destructive (D4). |
| Grounding guard too aggressive | Normalized-URL substring match; log drops in `warnings[]` for calibration (D5). |
| Hidden domain coupling creeps in | §2 rules + mandatory non-MR fixture in `parser-tests`/`e2e-verify` (D7). |
| `interaction_required` URLs need referer/session to download | OCTO downloader already supports `referer`; `retrieval` flag tells it which need special handling. |
| Contract drift (TS ↔ Py) | Single schema (this file); OCTO adapter validates; `/api/search` kept as fallback. |
