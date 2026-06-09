# Phase 2c — Unified Asset Discovery (FINAL, implementation-ready)

**Status:** Decisions locked (D1–D9). Ready to implement milestone-by-milestone.
**Date:** 2026-06-08
**Supersedes:** the Phase-2c draft spec. Follows `Phase2_Merged_Plan.md`, `DiscoveryEngine_API_Endpoint_Reference.md`.
**Systems:** Discovery-Engine "Vane" (`/Users/mac/NEXTECH/Discovery-Engine`, TS) + OCTO01 (`/Users/mac/NEXTECH/software/OCTO/OCTO01`, Py)

---

## 0. Grounding — verified against real data (not assumed)

Inspected chat `http://localhost:3000/c/b45e5844278ee9db79ee44f2270fb78ff57477e6`
(query: *"recent EEZ boundaries on marineregions.org … structured json"*). Verified facts:

- 3 response blocks: `research`, `source` (15 scraped sources), `text` (prose + embedded JSON). The **structured JSON in `text` is the "gold"**.
- **The 5 download URLs the LLM emitted appear VERBATIM in the scraped `source` content** (grounding test: 5/5 grounded, 0 ungrounded). The source content actually contains **24** real `download_file.php?name=…` URLs across 6 dataset families (EEZ, 12NM, 24NM, Archipelagic, High Seas, Internal Waters). **The LLM selected — it did not invent.**
- The LLM correctly kept only the **EEZ family, latest v12** (dropped the other 5 families + older versions) because the query was EEZ-scoped.

### Why OCTO01 drops/duplicates this today (confirmed in code + live test)
1. **HTTP-200 gate is too strict.** `download_file.php?name=…` returns **HTML (an agreement form), not a 200 binary** — under *no* referer/cookie strategy (tested: root-referer, no-referer, and Vane-style warm+referer all return `text/html`). So OCTO's pipeline filters these real URLs out and saved only `.php`/`.html` landing pages.
2. **No version collapsing.** OCTO returns v12 + v11 + older because nothing selects "latest".
3. **Interaction is a license form-POST, not a redirect.** The page is:
   ```html
   <form name="download" method="post">
     <input name="name"> <input name="organisation"> <input type="email" name="email">
     <input type="checkbox" name="agree" value="1"> <input type="submit" value="Download">
     <input name="firstname-<hash>" style="position:absolute;left:-11849px">  <!-- honeypot: leave empty -->
   </form>
   ```
   Retrieval requires POSTing `name`+`organisation`+`email`+`agree=1` (honeypot blank).

**Conclusion:** the `/chat` path already produces the clean, grounded, latest-only result; OCTO throws it away. Move discovery + structuring into Vane; make OCTO a thin consumer **plus an interaction-aware downloader**.

---

## 1. Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Source of the clean body | **Evolve `POST /api/asset-discovery`**. `/api/chat` (UI) and `/api/search` stay untouched. |
| D2 | Division of labor | **Vane discovers + structures; OCTO downloads + extracts files** (OCTO keeps pyshp/shapely/pdf stack + SQLite). |
| D3 | URLs failing live HTTP-200 | **Keep, with `verification_status` flag — never drop.** Plus **grounding guard**: every output URL must appear verbatim in some source's content. |
| D4 | Many versions (v1–v12) | **Latest = `is_latest` primary + `superseded_versions[]` (lossless).** |
| D5 | Process | Spec first (this doc), implement after review. |
| D6 | Sync vs async | **Sync first**; add job/poll only if `maxSources=10` runs approach the Vane timeout budget. |
| **D7** | **Interaction-gated files** | **Auto-submit a config-driven download identity via dynamic form detection** (detect `<form>`, map fields, fill from config, honeypot-aware). Fall back to `pending` if CAPTCHA/login/JS-wizard. |
| **D8** | **Multiple formats per dataset** | **Detect format dropdowns/option sets and iterate → one asset URL per format** (gpkg, shp, kml, …). |
| **D9** | **Requirement traceability** | **Response carries `requirement_ids[]`** per dataset/asset (for the §10 matrix + §14 data→output validation). |

---

## 2. Endpoint contract

### Request — `POST /api/asset-discovery`
One of `requirements[]` or `query` required.

```jsonc
{
  "requirements": [{ "id": "r1", "text": "EEZ boundaries shapefile, latest version" }],
  // OR "query": "latest World EEZ shapefile from marineregions.org",
  "urls": ["https://www.marineregions.org/"],   // optional seed URLs
  "sources": ["web"],                            // web | discussions | academic
  "optimizationMode": "balanced",                // speed | balanced | quality
  "maxSources": 10,                              // top-N candidate sources to iterate
  "history": [],                                 // optional, parity with chat/search routes
  "include_superseded_assets": false,            // false = superseded_versions carry metadata only (lean)
  "include_sources": false,                      // true = echo scraped sources[] for audit/debug
  "chatModel":      { "providerId": "...", "key": "qwen/qwen3.6-27b" },
  "embeddingModel": { "providerId": "...", "key": "..." },
  "systemInstructions": ""
}
```
Provider IDs auto-discovered via `GET /api/providers`. Use a model proven to respond
(`qwen/qwen3.6-27b` ✓; `qwen/qwen3.5-27b` & `ai21/jamba-large-1.7` time out).

### Response — clean JSON, no prose
```jsonc
{
  "query": "...",
  "generated_at": "2026-06-08T...Z",
  "datasets": [
    {
      "dataset_family": "World EEZ",
      "dataset_name": "World EEZ v12",
      "version": "v12",
      "is_latest": true,
      "release_date": "2023-10-25",
      "provider": "Flanders Marine Institute (VLIZ) / Marine Regions",
      "source_page": "https://www.marineregions.org/downloads.php",
      "requirement_ids": ["r1"],                 // D9 — which requirement(s) this satisfies
      "selection_reason": "matches requirement r1 (EEZ); latest version v12 within family",
      "description": "Global EEZ boundaries, UNCLOS zones …",
      "context": "cleaned excerpts from the source(s) that evidence this dataset (bullets, link sections, key catalog lines) — capped ~12–16k chars",
      "context_sources": [                        // traceability for the context above
        { "url": "https://www.marineregions.org/downloads.php", "title": "Downloads - Marine Regions" }
      ],
      "metadata": {                              // open bag (dynamic per publisher)
        "file_size": "122 MB", "download_count": 37063,
        "license": "CC BY 4.0", "formats": ["shapefile", "gpkg", "kml"]
      },
      "assets": [
        {
          "format": "shapefile",
          "label": "World EEZ v12 (shapefile)",
          "url": "https://www.marineregions.org/download_file.php?name=World_EEZ_v12_20231025.zip",
          "verification_status": "requires_interaction",  // verified_200 | requires_interaction | unverified
          "http_status": null,
          "found_in_source": true,               // grounding guard passed
          "requirement_ids": ["r1"],             // D9
          "source_page": "https://www.marineregions.org/downloads.php",
          "interaction": {                       // D7 — present when verification_status=requires_interaction
            "type": "form_post",                 // form_post | js | unknown
            "action": "https://www.marineregions.org/download_file.php?name=World_EEZ_v12_20231025.zip",
            "method": "post",
            "fields": [                           // detected; OCTO fills from config identity
              {"name": "name", "kind": "identity_name", "required": true},
              {"name": "organisation", "kind": "identity_org", "required": false},
              {"name": "email", "kind": "identity_email", "required": true},
              {"name": "agree", "kind": "agreement_checkbox", "value": "1"}
            ],
            "honeypot_fields": ["firstname-<hash>"]   // MUST be left empty
          }
        }
      ],
      "superseded_versions": [
        // Lean by default: metadata only. Full assets[] included ONLY when the
        // request sets "include_superseded_assets": true (D4 stays lossless either way).
        { "version": "v11", "release_date": "...", "source_page": "..." }
      ]
    }
  ],
  "data_pages": [   // pages that hold data inline (not a downloadable file): extracted, NOT saved as a file
    { "url": "https://.../eezmethodology.php", "title": "...", "requirement_ids": ["r1"], "extracted": { /* … */ } }
  ],
  "sources":   [ /* present only when include_sources=true: [{content, metadata}] scraped ground truth for audit */ ],
  "dropped":   [
    { "url": "https://.../faq.php", "reason": "navigation" },
    { "dataset_family": "World 12NM", "reason": "requirement_mismatch" },   // unmatched family (step 9b)
    { "url": "https://.../older.zip", "reason": "superseded" }
  ],
  "warnings":  [ /* e.g. "grounding-dropped: <url> (not verbatim in any source)" */ ]
}
```

`verification_status`: `verified_200` (live HEAD/GET 2xx, file payload) · `requires_interaction` (known gate/form, present in content) · `unverified` (in content, HTTP check inconclusive/skipped). **Status never filters — it only annotates.** For `requires_interaction`, set `http_status` to the real code observed (e.g. `200` when the GET returned the HTML form) and let `verification_status` carry the retrieval semantics — don't leave `http_status` null just because it isn't a file.

---

## 3. Vane pipeline (internal)

```
[1] Search + scrape top-N sources              (existing researcher; reuse scrapeURL.ts)
    └─ RELIABILITY: when queryRequestsAssets()/requirements imply assets, auto-scrape the top
       trusted catalog URLs found by search (/downloads, /releases, …). Domain-agnostic, NOT
       left to agent discretion — without this the synthesizer has nothing to parse (flaky runs).
[2] Classify each source: asset_host | data_page | navigation   (isAssetLikeUrl + heuristics)
[3] Per-source extraction → candidate assets + metadata
    └─ DETERMINISTIC PRE-PASS first: parse the existing "## Verified download links" /
       "## Downloads requiring user interaction" sections + catalog lines (regex, no LLM).
       Invoke the LLM structured pass ONLY when grouping/version is ambiguous (cost saver at maxSources=10).
       LLM reads source.content ONLY (never prose message). Give the TS LLM call max_tokens headroom.
[4] GROUNDING GUARD: drop any asset.url not present verbatim (normalized) in that source's content → log to warnings[]
[5] HTTP probe → verification_status            (reuse verifyDownloadUrls; status only, NOT a gate)
[6] Detect interaction (D7): if gated, GET the page, parse <form>, emit interaction{} spec (fields/honeypot)
[7] Multi-format expansion (D8): enumerate <select>/option sets / per-format URLs → one asset per format
[8] Dedup across sources: key=(dataset_family, version, format, normalized-url); keep most-trusted   (compareSourceTrust)
[9] REQUIREMENT FILTER (9b): score each dataset_family/name vs requirements[]+query (generic keyword/LLM,
    NOT publisher-specific). Unmatched families → dropped[] reason="requirement_mismatch".
    └─ This is what keeps EEZ-only and drops 12NM/24NM/High Seas/etc. in the gold chat.
[10] Version select (D4): within each MATCHED family, mark one is_latest (per family, NOT global);
     rest → superseded_versions (metadata-only unless include_superseded_assets=true) + dropped[] reason="superseded"
[11] Requirement mapping (D9): attach requirement_ids[] to surviving datasets/assets
[12] Return clean JSON (datasets[], data_pages[], sources[]?, dropped[], warnings[])
```

**Reusable Vane blocks (verified to exist):** `scrapeURL.ts`, `extractLinks.ts` (`isAssetLikeUrl`, `normalizeScrapeTargets`, `formatVerifiedLinksSection`), `verifyUrls.ts` (`verifyDownloadUrls`, `warmPageSession`), `trustedSources.ts` (`compareSourceTrust`, `getSourceTrustScore`), `assetPipeline.ts` (`queryRequestsAssets`), current `asset-discovery/route.ts` (regex parsers → evolve to LLM-structured).

---

## 4. Anti-hallucination (hard requirements)

1. Extraction reads `source.content` + resolved links **only**. The writer/prose `message` is **never** parsed for URLs/versions/facts.
2. **Grounding guard (step 4):** every `assets[].url` MUST appear verbatim in some scraped source's content (after URL normalization). Otherwise drop + record in `warnings[]`. *Verified: this keeps the 24 real `download_file.php` URLs while killing invented ones.*
3. **URL normalization before matching:** decode HTML entities (`&amp;`→`&`), resolve relative→absolute, strip tracking params/fragments. Prevents wrongly dropping valid URLs.
4. `verification_status` records reality; it does **not** filter (D3).
5. Endpoint returns **no prose**.

---

## 5. HTML/PHP data-page handling

- **`asset_host`** → emit `assets[]` (+ `interaction{}` if gated). OCTO downloads.
- **`data_page`** → page itself carries the data (tables/specs/methodology): clean + chunk + LLM-extract into `data_pages[].extracted`. **Not** saved as a file.
- **`navigation`** → `dropped[]` with reason.

---

## 6. OCTO01 — thin consumer + interaction-aware downloader (D2, D7, D8)

### 6.1 Adapter
- New adapter in `discovery_client.py` parses the 2c response into internal `DiscoveryResult` / `CandidateAsset` (+ new fields: `verification_status`, `interaction`, `requirement_ids`, `superseded_versions`, `context`). Stays endpoint-agnostic (merged-plan §4).
- **`validator.py` must honor `verification_status`.** It already does NOT 200-gate (it hard-rejects only on 404/410 and KEEPs URLs whose path/query ends in a known format, e.g. `download_file.php?name=…zip`, flagging `requires_retrieval`). Add an explicit rule for the remaining case: **when an asset carries `verification_status="requires_interaction"` or an `interaction{}` spec, KEEP it even if the URL has no detectable format extension** — never downgrade a Vane-confirmed gated asset to `NEED_ANOTHER_SOURCE` for a non-200 bare GET.

### 6.2 Downloader retrieval strategy (NEW — the part that actually lands files)
For each asset, by `verification_status`:
- `verified_200` → GET + save (existing path).
- **`requires_interaction` (D7):**
  1. GET the interaction URL; if HTML with a `<form>`, use the `interaction{}` spec (or parse the form live).
  2. **Fill fields from a config-driven identity** (`DOWNLOAD_IDENTITY_NAME / _EMAIL / _ORG`), tick `agreement_checkbox`; **leave `honeypot_fields` empty**.
  3. POST (form `method`/`action`) → if binary, save + extract; if still HTML, escalate to Playwright (Crawl4AI) or mark `pending`.
  4. **Audit log every auto-accepted agreement**: URL, license snapshot, identity used, timestamp → audit sidecar (defensibility + lineage).
- **Multi-format (D8):** for a dataset with multiple formats, iterate each format's asset URL → download each (one file per format).
- `unverified` → attempt GET; on HTML/failure, mark `pending`.

Static forms (like marineregions) work with `httpx` (no browser). Reserve Playwright for JS gates.

### 6.3 Keep / fallback
- **Keep:** `downloader.py` + `extractors/*` (shapefile→7 JSON, etc.), SQLite, matrix builder, `validator.py`.
- **Keep as cross-check/fallback (do NOT retire yet):** `asset_extractor.py`, `dedup_conflict.py`, `trust_ranker.py` — used when `datasets[]` is empty, and as a sanity cross-check while 2c stabilizes.
- Keep `/api/search` + `/api/chat` adapters as documented fallbacks.

---

## 7. Config additions (OCTO)

```
DOWNLOAD_IDENTITY_NAME=          # used to auto-fill agreement forms (D7); config-only, never hardcoded
DOWNLOAD_IDENTITY_EMAIL=
DOWNLOAD_IDENTITY_ORG=
ASSET_DISCOVERY_AUTO_ACCEPT_LICENSE=true   # explicit opt-in to auto-submit agreement forms
ASSET_DISCOVERY_MAX_SOURCES=10
```

---

## 8. Milestones (each: run → inspect real response → verification note → fix)

1. **Endpoint skeleton + catalog-scrape reliability** — accept `requirements[]`/`query`, search+scrape top-N, return raw per-source candidates (no LLM). **Make catalog scrape mandatory when asset intent is detected** (don't leave it to agent choice) — prerequisite for every later milestone. Curl-prove shape + that catalog pages were actually fetched.
2. **LLM structured extraction + grounding guard** — curl-prove: marineregions assets carry real `download_file.php` URLs, `found_in_source:true`.
3. **HTTP probe + `verification_status`** — confirm `download_file.php` → `requires_interaction`, a true file → `verified_200`.
4. **Interaction detection (D7) + multi-format (D8)** — `interaction{}` spec emitted with fields/honeypot; per-format assets enumerated.
5. **Dedup + requirement filter + version select (D4)** — assert: unmatched families (12NM/24NM/High Seas/…) go to `dropped[] reason="requirement_mismatch"`; only the EEZ family survives; within it a single `is_latest` v12 + `superseded_versions` v1–v11 (metadata-only by default); families kept distinct.
6. **Requirement mapping (D9)** — `requirement_ids[]` correct on datasets/assets.
7. **Data-page extraction (§5)** — methodology/PHP page → `data_pages[].extracted`, not a saved file.
8. **OCTO adapter + interaction-aware downloader (§6)** — E2E: Vane JSON → OCTO **form-POST download** of EEZ v12 zip → shapefile→7 JSON → SQLite. Confirm an actual file lands (not HTML), audit log written.
9. **Generalization gate** — one non-maritime, multi-family publisher (e.g. a GitHub releases page or data.gov portal): families distinct, latest selected, no MR-specific behavior.
10. **Sync→async** only if `maxSources=10` runs approach the timeout budget.

---

## 9. Build-time best-practices / risks

| Risk | Mitigation |
|---|---|
| **Gated retrieval is the make-or-break step** — right URL ≠ downloaded file | D7 form-autofill in OCTO downloader; verified marineregions is a static POST (httpx works); Playwright fallback for JS gates |
| Auto-accepting licenses + submitting identity (ToS/PII) | Config-only identity; explicit `AUTO_ACCEPT_LICENSE` opt-in; **audit-log every agreement**; respect sites that forbid automated download → `pending` |
| Grounding guard too aggressive | Normalize URLs (entities/relative/tracking) before match; log drops to `warnings[]` for calibration |
| Vane structuring LLM truncates JSON | Give the TS-side LLM call **`max_tokens` headroom** (reasoning models like qwen3.6 burn hidden budget — same bug fixed in OCTO) |
| `dataset_family` mis-grouping (EEZ vs 12NM vs High Seas) | Group by family first; `superseded_versions` makes version errors non-destructive; test on the generalization gate |
| LLM cost/latency moves into Vane (N per-source calls) | `maxSources` cap; sync-first then async; measure at maxSources=10 before assuming sync |
| Retiring OCTO services too early | Keep `asset_extractor`/`dedup_conflict`/`trust_ranker` as fallback + cross-check until 2c proven |
| CAPTCHA / login / multi-step wizards | Out of scope for auto-submit → `pending` with `interaction{}` spec stored for human/later |
| Contract drift Vane(TS) ↔ OCTO(Py) | This doc is the single schema; OCTO adapter validates; `/api/search` + `/api/chat` kept as fallbacks; full raw Vane response persisted for audit |

---

## 10. Success criteria

- **EEZ validation case:** one `is_latest` EEZ v12 dataset (not v11/older, not the other 5 families), N format assets under it, **an actual downloaded+extracted file** (form-POST succeeded), `superseded_versions` populated, no dup URLs, audit log written.
- **General:** identical response shape for a non-maritime publisher; `datasets[]` empty only when no asset intent or no scrape success — never because a publisher is "unsupported"; full raw Vane response persisted.
