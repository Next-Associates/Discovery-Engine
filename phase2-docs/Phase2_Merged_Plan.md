# Phase 2 — Data-Asset Discovery & Availability System (Merged Plan)

**Status:** Proposed (merged from Plan 1 + Plan 2, corrected against verified source code)
**Date:** 2026-06-07
**Systems:** OCTO01 (`/Users/mac/NEXTECH/software/OCTO/OCTO01`, Python) + Discovery-Engine "Vane" (`/Users/mac/NEXTECH/Discovery-Engine`, live `http://31.97.33.98:3000`)

---

## 0. Why this merged plan exists

Two prior plans were judged against the **actual code** (both codebases were read, not assumed):

- **Plan 1** correctly saw that Vane already computes **HTTP-200-verified download URLs** (`verifyUrls.ts`) and **trust-sorted sources** (`compareSourceTrust`), and that this ground truth is currently flattened into prose. Its milestone discipline and the *requirement → required_fields → data-to-output* generic structure are the right backbone. But it wanted to modify Vane up front, scattered new code into the existing `backend/services/`, and overstated some Vane internals.
- **Plan 2** had the better engineering hygiene — an **additive `backend/phase2/` package** (zero risk to the working v1 pipeline) and an **external NAUTILUS taxonomy YAML** (keeps the system domain-agnostic). But it chose the **wrong Vane endpoint** (`/api/chat`, the UI NDJSON block-stream) as primary and would re-derive download URLs by LLM-parsing prose — reintroducing the hallucination risk we set out to eliminate.

**Both missed the correct endpoint: `/api/search`** (verified working — returns clean `{message, sources}` JSON; see `DiscoveryEngine_API_Endpoint_Reference.md`).

### Verified corrections applied here
- Use **`/api/search`**, not `/api/chat`. (`/api/chat` is the UI stream.)
- Vane `VerifiedDownload` fields are **`{label, url, status}`** (not `sourceHref/format/foundOnPage`).
- Vane trust ranking is a **numeric scorer** (`getSourceTrustScore`: +10 trusted-domain, −3 low-trust, 1 default), **not** a named 6-tier ladder. The named tiers (international→government→…→unknown) are **classified in OCTO01**, not read from Vane.
- `verifyDownloadUrls` lives in `verifyUrls.ts` (not `assetPipeline.ts`).
- OCTO01 has **no SQLite, no geo libs** today; clean architecture confirmed (config/DI/repository/exceptions). Target `extracted/*.json` artifacts and `multi_sessions/term_expansions.json` exist and are the shape contract.

---

## 1. Locked decisions

1. **Orchestrate from OCTO01 (Python).** Vane is an external HTTP service.
2. **Integration is staged (the key decision):**
   - **Phase 2a — `/api/search` (NOW, zero Vane change).** Clean `{message, sources}` contract. `sources[]` is trust-sorted ground truth. OCTO01 does its own URL verification (it must, because it downloads anyway).
   - **Phase 2b — `/api/asset-discovery` (LATER, local→prove→deploy).** A small additive Vane endpoint that surfaces the already-computed `verifiedDownloads[]` + per-source trust score, eliminating redundant re-verification. `/api/search` remains the permanent fallback adapter. **Downstream OCTO01 stays endpoint-agnostic** via a normalized internal contract, so 2b is a drop-in upgrade.
3. **All new OCTO01 code is additive under `backend/phase2/`.** The v1 pipeline (`/api/v1/discovery`) is never touched.
4. **Reuse v1 building blocks:** `LLMProvider`/`OpenRouterProvider`, `crawl_service`, `extraction_service`, `processing_service`, `config.py` settings pattern, `dependencies.py` DI, repository pattern, exception hierarchy.
5. **SQLite via stdlib `sqlite3` + a thin repository** mirroring `job_repository.py`'s interface (models stay Pydantic). Avoids a heavy new dep; matches the existing repository pattern. (SQLModel reconsidered only if migrations get complex.)
6. **NAUTILUS is an external `taxonomy/nautilus.yaml`** loaded at runtime — informs prompts/classification only. **No regulatory gating/scoring engines.** Maritime appears only in seed/test data, never in code branches.
7. **Generalization is a gate, not an afterthought:** the acceptance suite runs one maritime set **and** one non-maritime set.

---

## 2. Target architecture & data flow

```
Input: requirements[] (REQUIRED) + urls[]? (optional) + calculation_context? (optional)
   │
   ▼  backend/phase2/services/pipeline.py  (orchestrator)
[1] PromptRewriter (LLM)
      requirements → directive query + per-requirement expansions
      (synonyms, file_hints, path_hints, required_fields, output_schema_hint)
   │
   ▼
[2] SourceDiscovery (only if no URL given)
      Vane /api/search web query per requirement → candidate source URLs
   │
   ▼
[3] DiscoveryClient → Vane
      Phase 2a: POST /api/search  → { message, sources[] }
      Phase 2b: POST /api/asset-discovery → { sources[], verifiedDownloads[], catalogPages[], unverified[] }
      (both normalized to ONE internal DiscoveryResult shape)
   │
   ▼
[4] AssetExtractor (LLM)
      parse sources[] (NOT message) → CandidateAsset[]:
      location, format, collection_method, hosting(direct/external/referenced),
      currency, availability_status (§9), source_relationship (§15),
      per-requirement relevance (§8)
   │
   ▼
[5] TrustRanker
      classify trust_tier (intl→gov→institutional→commercial→secondary→unknown)
      + source lineage (primary/secondary-host/reference/aggregator/external)
   │
   ▼
[6] Dedup + Conflict
      group same-data; pick one trusted working source (keep alternates);
      conflicts → store BOTH + flag + recommend preferred (NEVER auto-merge) (§3,§12)
   │
   ▼
[7] Validator
      re-verify URL works (HEAD→GET); if calculation_context: required_fields present?
      → keep | review | need-another-source (§14)
   │
   ▼  (missing/unverified)
[8] Crawl4AI fallback  → reuse v1 crawl_service + extraction_service → loop back to [4]
   │
   ▼
[9] Downloader + FormatExtractor registry
      download verified assets → organized/categorized/hash-flagged local store (§11)
      ZIP extract; shapefile→7 JSON artifacts; gpkg/kml/csv/xlsx/pdf/xml→JSON;
      unextractable→JSON metadata stub
   │
   ▼
[10] MatrixBuilder → Availability Matrix (§10) + metadata answers (§8)
      + data→output validation table (§14)
   │
   ▼
[11] SQLite persistence + FastAPI/Streamlit output
```

Validation + bounded retry wrap every stage; a per-step verification note is written each run.

---

## 3. Code layout (additive — v1 untouched)

```
backend/phase2/
  __init__.py
  models.py            # Pydantic: DiscoveryTarget, Requirement, DiscoveryResult,
                       #   CandidateAsset (extends DataAsset concept), SourceRecord,
                       #   SourceConflict, AvailabilityMatrixRow, DownloadRecord, DiscoverySession
  enums.py             # TrustTier, SourceRelationship, AvailabilityStatus, RelevanceDecision,
                       #   extended AssetFormat (gpkg,kml,kmz,shp_zip,wfs,wms,html,zip,geotiff,image,external),
                       #   CollectionMethod (extends v1)
  services/
    prompt_rewriter.py   # LLM: requirements(+urls?+calc?) → directive query + expansions
    source_discovery.py  # no-URL case: Vane web search → candidate URLs
    discovery_client.py  # async httpx; /api/search adapter NOW, /api/asset-discovery adapter LATER;
                         #   normalizes both to DiscoveryResult; retry/backoff/timeout; provider auto-discovery
    asset_extractor.py   # LLM: sources[] → CandidateAsset[] (compare to requirement & source)
    trust_ranker.py      # trust_tier + lineage classification
    dedup_conflict.py    # criteria-based dedup (§3) + conflict store-both/flag/recommend (§12)
    validator.py         # URL re-verify (HEAD→GET) + data→output validation (§14)
    crawl_fallback.py    # wraps v1 crawl_service + extraction_service for unmet requirements
    downloader.py        # organized/categorized/hash-flagged local store (§11)
    extractors/          # FormatExtractor strategy registry (open/closed)
      base.py            #   FormatExtractor ABC: supports(fmt) -> bool; extract(path) -> list[Path]
      shapefile.py csv.py xlsx.py pdf.py geojson.py gpkg_kml.py xml_feed.py zip_bundle.py fallback_json.py
    matrix_builder.py    # Availability Matrix (§10) + metadata (§8) + validation table (§14)
    pipeline.py          # orchestrator (parallels v1 discovery_service.py)
  repositories/
    discovery_repository.py   # stdlib sqlite3, mirrors job_repository.py interface
  taxonomy/
    nautilus.yaml             # dimensions/sub-dimensions taxonomy (loaded, not hardcoded)
    loader.py

backend/api/phase2.py                 # FastAPI router /api/v2/...
backend/api/schemas/phase2.py         # request/response schemas
```

**Edited (additively):** `backend/main.py` (mount v2 router), `backend/core/config.py` (+ Phase-2 settings), `backend/dependencies.py` (+ v2 wiring), `requirements.txt` (+ parse/geo deps), `frontend/app.py` (+ "Targeted Discovery" tab), `.env.example`.

**Reused as-is:** `backend/services/{crawl_service,extraction_service,processing_service,validation_service}.py`, `backend/providers/*`, `backend/core/exceptions.py`.

---

## 4. Internal contract (endpoint-agnostic)

The whole pipeline depends only on this normalized shape, so the 2a→2b swap is invisible downstream:

```python
class NormalizedSource(BaseModel):
    url: str
    title: str | None
    content: str            # scraped snippet/body (GROUND TRUTH)
    trust_score: float | None = None   # filled by Vane in 2b, else by TrustRanker

class NormalizedDownload(BaseModel):  # only populated in 2b
    label: str
    url: str
    status: int | None

class DiscoveryResult(BaseModel):
    message: str                       # treated as HINT ONLY, never as fact source
    sources: list[NormalizedSource]
    verified_downloads: list[NormalizedDownload] = []
    catalog_pages: list[str] = []
    unverified: list[str] = []
```

**Anti-hallucination rule (enforced in `asset_extractor.py`):** facts and URLs are extracted from `sources[].content` and `verified_downloads[]` only. `message` is never parsed for URLs/versions. (Confirmed root cause from prior testing: `message` over-claims; `sources[]` is live-scraped truth.)

### Phase 2a request (`/api/search`)
```jsonc
{
  "query": "<directive query from PromptRewriter>",
  "sources": ["web"],
  "optimizationMode": "balanced",
  "stream": false,
  "systemInstructions": "<trust-ranking + scraped-only rules>",
  "chatModel":      { "providerId": "<from GET /api/providers>", "key": "anthropic/claude-haiku-4.5" },
  "embeddingModel": { "providerId": "<...>", "key": "Xenova/all-MiniLM-L6-v2" }
}
```
Provider IDs are auto-discovered via `GET /api/providers` (cached), never hardcoded.

### Phase 2b endpoint (`/api/asset-discovery`, added to Vane later)
- New route `src/app/api/asset-discovery/route.ts` (mirrors `chat/route.ts` setup, **non-streaming JSON**).
- Runs the existing `classify → Researcher.research()` path; instead of the prose writer, returns:
  ```jsonc
  { "sources": [{ "url", "title", "trustScore" }],
    "verifiedDownloads": [{ "label", "url", "status" }],   // from scrapeURL.ts (already built)
    "catalogPages": [{ "url", "title" }],
    "unverified": [{ "url" }] }
  ```
- Implementation: thread a lightweight structured collector through `researcher/actions/scrapeURL.ts` to record each `VerifiedDownload` as an object on the session (the data already exists at scrapeURL.ts ~L243-253; it's currently only appended to prose). Reuse `compareSourceTrust`, `verifyDownloadUrls`, `isAssetLikeUrl`, `normalizeScrapeTargets`, `extractLinks` formatters.
- `/api/chat` and `/api/search` stay untouched; live server redeployed only after curl-proven locally.

---

## 5. Domain models & enums (spec mapping)

- **AvailabilityStatus** (§9): available, partially_available, not_available, available_api, available_download, available_manual, external_source, restricted, unclear, needs_review.
- **Relevance** (§8): required, secondary, excluded, needs_review.
- **SourceRelationship** (§15): primary, secondary_host, reference, aggregator, external.
- **TrustTier** (§2): international_org, government, institutional, commercial, secondary, unknown.
- **AssetFormat** (§7): extend v1 `FileFormat` with gpkg, kml, kmz, shp_zip, wfs, wms, html, zip, geotiff, image, external.
- **CandidateAsset** = v1 `DataAsset` fields + availability_status, data_location, auto_collectable (yes/no/partial), requires_login, hosting, currency, relevance, source_relationship, trust_tier, verified_url, http_status, local_path?, extracted_json_paths[].
- **Requirement** = { id, text, calculation_context?, synonyms[], file_hints[], path_hints[], required_fields[], output_schema_hint } (revives `multi_sessions/term_expansions.json`).
- **SourceConflict** (§12) = { requirement_id, value_a, value_b, conflict_type, sources[], recommended_source, reason }. **Never auto-merged.**

---

## 6. SQLite schema (`DATA_DIR/discovery.db`)

`sessions`, `requirements`, `sources` (url, trust_tier, relationship, lineage_of), `assets` (format, availability_status, collection_method, relevance, hosting, currency, required_fields, verified, http_status, local_path), `conflicts` (requirement_id, source_a, source_b, type, value_a, value_b, preferred_source, reason), `downloads` (asset_id, local_path, content_hash, extracted_json_paths), `availability_matrix` (the §10 rows), `source_lineage` (§15 true lineage). Repository mirrors `job_repository.py` so services stay storage-agnostic.

---

## 7. Asset extraction to JSON (FormatExtractor registry)

Output must match the existing `extracted/*.json` shapes exactly (verified present).

- **Dependency choice (risk-managed):** prefer the **lighter stack** `pyshp` + `shapely` + `pyproj` + `openpyxl` + `pdfplumber` + `lxml` over full `geopandas`/`fiona` (heavy native builds in the 3.11 venv/Docker). geojson/wkt export replicated from pyshp→shapely without geopandas. **Gate:** confirm the lighter stack reproduces the 7 reference artifacts before committing; only fall back to geopandas/pyogrio if it can't.
- **Shapefile bundle** → `projection.json` (.prj WKT→CRS), `attributes.json` (.dbf), `index.json` (.shx), `geometry_meta.json` (.shp header/bbox/count/CRS), `geometry.geojson`, `geometry_wkt.json`, `sidecar_*.txt`.
- **GeoPackage/KML/GML** → geojson/wkt/meta JSON. **CSV/XLSX** → rows+schema JSON. **XML/feeds** → fetch+structured JSON. **PDF** → text+tables JSON (validation flag). **HTML tables** → rows JSON. **Unextractable** → JSON metadata stub flagging manual/OCR.
- Each format = one `FormatExtractor` strategy (open/closed; new formats slot in without touching callers).

---

## 8. API (additive)

`POST /api/v2/asset-discovery/start { requirements[], urls?, calculation_context? }` → session_id;
`GET /api/v2/asset-discovery/{id}/status`; `GET …/results` (matrix + assets + conflicts);
`GET …/{id}/matrix`; `GET …/{id}/assets`. Schemas in `backend/api/schemas/phase2.py`.
Streamlit: new "Targeted Discovery" tab — requirements (required) + optional URLs + optional calculation → seamless run → matrix table + downloaded-assets browser. No mid-pipeline interaction.

---

## 9. Milestones (each independently runnable + verified; Vane change is LAST)

1. **Skeleton + SQLite + config + models/enums.** Round-trip a `DiscoverySession`; migrations create cleanly.
2. **DiscoveryClient on `/api/search` + provider auto-discovery.** Curl-equivalent call returns normalized `DiscoveryResult`; verify `sources[]` populated, `message` ignored for facts.
3. **PromptRewriter + SourceDiscovery.** requirements → expansions → query; no-URL case discovers candidate sources.
4. **AssetExtractor + TrustRanker + Dedup/Conflict + Validator.** Produce `CandidateAsset[]` + `SourceConflict[]` + keep/review/need-source for a sample requirement set; assert store-both/no-auto-merge.
5. **Downloader + FormatExtractor registry.** Real shapefile ZIP → 7 JSON artifacts on disk; assert byte-shape against reference `extracted/*.json`.
6. **Crawl4AI fallback.** Force an unmet requirement; confirm v1 crawl fills it and loops back.
7. **MatrixBuilder + API + Streamlit.** End-to-end maritime EEZ acceptance slice (URL optional) → matrix + assets + conflicts persisted in SQLite.
8. **Generalization gate.** Run a **non-maritime** requirement set (e.g. a financial/open-data portal) → prove no domain coupling.
9. **Phase 2b — Vane `/api/asset-discovery`** (local only → curl-prove → deploy). Swap DiscoveryClient adapter; verify identical/better results with real `verifiedDownloads[]`; `/api/search` stays as fallback.

After each step: run, inspect the real response, write a short verification note, fix before proceeding.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `message` hallucination leaks into output | Extract only from `sources[].content`/`verified_downloads[]`; `message`=hint. Enforced in asset_extractor + reviewed in tests. |
| Heavy geo deps fail to build (3.11/Docker) | Use lighter pyshp/shapely/pyproj stack; gate on reproducing reference artifacts before commit. |
| Vane per-mode timeouts (90/180/300s) | DiscoveryClient honors timeouts with its own retry budget; long runs use status/poll. |
| LLM drops valid sources in dedup/rerank | Dedup keeps alternates (never deletes); conflicts stored both ways; calibrate on the §14 keep/review/need-source cases. |
| 2b Vane refactor breaks UI | New route only; `/api/chat` & `/api/search` untouched; deploy after local curl proof. |
| Cross-language contract drift | Single normalized `DiscoveryResult`; adapters validated; `/api/search` pinned as fallback. |

---

## 11. Out of scope (this phase)
Regulatory gating/scoring engines. Multi-domain financial connectors (taxonomy is built to allow them later). Modifying Vane's `/api/chat` or `/api/search`.
