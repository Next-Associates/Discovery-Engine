/**
 * Phase 2c — Unified Asset Discovery pipeline (deterministic core).
 *
 * Milestone 1: search + scrape top-N + MANDATORY catalog scrape -> raw per-source
 * candidates. No agent loop, no LLM, no HTTP verification yet.
 *
 * Pipeline (spec §3):
 *   [1] Search candidate pages (SearXNG, direct — not the agent loop)
 *       RELIABILITY: when asset intent is detected, auto-expand top trusted results
 *       to their catalog index pages (/downloads, /downloads.php, ...) and force-scrape
 *       them. Domain-agnostic, NOT left to agent discretion.
 *   [2] Classify each source: asset_host | data_page | navigation
 *   [3] Per-source raw candidate extraction (asset-like links, verbatim)
 *
 * Later milestones add: LLM structuring + grounding (M2), verification_status (M3),
 * interaction{}/multi-format (M4), dedup/requirement-filter/version-select (M5), etc.
 */
import { searchSearxng } from '@/lib/searxng';
import { queryRequestsAssets, normalizeScrapeTargets } from '@/lib/utils/assetPipeline';
import { getSourceTrustScore } from '@/lib/utils/trustedSources';
import ModelRegistry from '@/lib/models/registry';
import { scrapeSource } from './scrapeSource';
import { resolveChatLLM } from './resolveModels';
import { structureDatasets } from './structure';
import { verifyDatasetAssets } from './verifyAssets';
import { attachInteractions } from './interaction';
import { postProcessDatasets } from './postProcess';
import { extractDataPages } from './dataPages';
import {
  AssetDiscoveryInput,
  AssetDiscoveryResult,
  Requirement,
  RawSource,
  DroppedEntry,
} from './types';

const DEFAULT_MAX_SOURCES = Number(process.env.ASSET_DISCOVERY_MAX_SOURCES ?? 10);
const SCRAPE_CONCURRENCY = Number(process.env.ASSET_DISCOVERY_SCRAPE_CONCURRENCY ?? 6);

/** Catalog/index pages (plural /downloads, /releases) — not direct files. */
export function isCatalogIndexUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return (
      /\/downloads?(\.php|\.html)?\/?$/.test(path) ||
      /\/releases?\/?$/.test(path) ||
      /\/data(sets)?\/?$/.test(path) ||
      path === '/' ||
      path === ''
    );
  } catch {
    return false;
  }
}

/** Normalize the unified query/requirements into search queries (max 4, deduped). */
export function buildSearchQueries(input: AssetDiscoveryInput): string[] {
  const queries: string[] = [];
  if (input.requirements?.length) {
    for (const r of input.requirements) {
      if (r.text?.trim()) queries.push(r.text.trim());
    }
  }
  if (input.query?.trim()) queries.push(input.query.trim());

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const q of queries) {
    const k = q.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(q);
  }
  return deduped.slice(0, 4);
}

export function normalizeUrlKey(url: string): string {
  // Strip trailing punctuation that leaks in from prose/search snippets
  // (e.g. "...downloads.php." or a trailing comma) so they don't scrape twice.
  const cleaned = url.trim().replace(/[.,;)\]]+$/, '');
  try {
    const u = new URL(cleaned);
    u.hash = '';
    return u.href.toLowerCase().replace(/\/$/, '');
  } catch {
    return cleaned.toLowerCase();
  }
}

export async function runAssetDiscovery(
  input: AssetDiscoveryInput,
): Promise<AssetDiscoveryResult> {
  const requirements: Requirement[] = input.requirements ?? [];
  const queries = buildSearchQueries(input);
  const combinedQuery = queries.join(' ');
  const maxSources = input.maxSources ?? DEFAULT_MAX_SOURCES;
  const assetIntent =
    requirements.length > 0 || queryRequestsAssets(combinedQuery);

  const warnings: string[] = [];

  // ── [1] Search candidate pages ─────────────────────────────────────────────
  const candidateUrls: string[] = [];
  const candidateSeen = new Set<string>();
  const addCandidate = (url: string) => {
    const key = normalizeUrlKey(url);
    if (candidateSeen.has(key)) return;
    candidateSeen.add(key);
    candidateUrls.push(url);
  };

  // Seed URLs always lead.
  for (const u of input.urls ?? []) addCandidate(u);

  await Promise.all(
    queries.map(async (q) => {
      try {
        const res = await searchSearxng(q);
        for (const r of res.results.slice(0, 15)) {
          if (r.url) addCandidate(r.url);
        }
      } catch (err) {
        warnings.push(
          `search failed for "${q}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  // Rank by trust (authoritative publishers first); stable for equal scores.
  const ranked = candidateUrls
    .map((url, idx) => ({ url, idx, trust: getSourceTrustScore(url) }))
    .sort((a, b) => b.trust - a.trust || a.idx - b.idx)
    .map((c) => c.url);

  // ── Build the scrape target list with MANDATORY catalog expansion ───────────
  const targets = new Map<string, boolean>(); // url -> isCatalog
  const addTarget = (url: string, isCatalog: boolean) => {
    const key = normalizeUrlKey(url);
    if (targets.has(key)) {
      // Upgrade to catalog flag if any path marks it so.
      if (isCatalog && !targets.get(key)) targets.set(key, true);
      return;
    }
    targets.set(key, isCatalog);
  };
  // Map normalized keys back to a concrete URL to scrape.
  const keyToUrl = new Map<string, string>();

  for (const url of ranked) {
    const key = normalizeUrlKey(url);
    if (!keyToUrl.has(key)) keyToUrl.set(key, url);
    addTarget(url, isCatalogIndexUrl(url));

    if (assetIntent) {
      // RELIABILITY: force the catalog index variants of every candidate.
      for (const variant of normalizeScrapeTargets(url)) {
        if (normalizeUrlKey(variant) === key) continue;
        const vKey = normalizeUrlKey(variant);
        if (!keyToUrl.has(vKey)) keyToUrl.set(vKey, variant);
        addTarget(variant, true);
      }
    }
    if (targets.size >= maxSources) break;
  }

  const scrapeList = [...targets.entries()]
    .slice(0, maxSources)
    .map(([key, isCatalog]) => ({ url: keyToUrl.get(key)!, isCatalog }));

  // ── [2][3] Scrape (bounded concurrency) -> raw per-source candidates ────────
  const raw_sources: RawSource[] = [];
  for (let i = 0; i < scrapeList.length; i += SCRAPE_CONCURRENCY) {
    const batch = scrapeList.slice(i, i + SCRAPE_CONCURRENCY);
    const scraped = await Promise.all(
      batch.map((t) => scrapeSource(t.url, t.isCatalog)),
    );
    raw_sources.push(...scraped);
  }

  const catalog_pages_fetched = raw_sources
    .filter((s) => s.is_catalog && !s.error && s.content_length > 0)
    .map((s) => s.url);

  const candidates_found = raw_sources.reduce(
    (n, s) => n + s.candidate_assets.length,
    0,
  );

  if (assetIntent && catalog_pages_fetched.length === 0) {
    warnings.push(
      'asset intent detected but no catalog index page was successfully fetched',
    );
  }

  // ── [3] LLM structured extraction + [4] grounding guard ─────────────────────
  let datasets: any[] = [];
  const dropped: DroppedEntry[] = [];
  let structuringModel: string | null = null;
  let verificationTally = { verified: 0, interaction: 0, unverified: 0 };
  let data_pages: unknown[] = [];
  const haveCandidates = raw_sources.some((s) => s.candidate_assets.length > 0);
  const DATA_PAGE_LIMIT = Number(process.env.ASSET_DISCOVERY_DATA_PAGE_LIMIT ?? 4);
  const dataPageSources = raw_sources
    .filter((s) => s.classification === 'data_page' && !s.error && s.content_length > 0)
    .sort((a, b) => b.trust_score - a.trust_score || b.content_length - a.content_length)
    .slice(0, DATA_PAGE_LIMIT);
  const needLLM = haveCandidates || dataPageSources.length > 0;

  if (needLLM) {
    const registry = new ModelRegistry();
    const { llm, resolvedKey } = await resolveChatLLM(registry, input.chatModel);
    if (!llm) {
      warnings.push('no chat model available — returning raw candidates only (no datasets[])');
    } else {
      structuringModel = resolvedKey;
      if (haveCandidates) {
      const structured = await structureDatasets(
        raw_sources,
        requirements,
        combinedQuery,
        llm,
      );
      datasets = structured.datasets;
      dropped.push(...structured.dropped);
      warnings.push(...structured.warnings);

      // ── [8] dedup → [9b] requirement filter → [10] version select (D4) ──────
      // Done before verification so we only probe the surviving, collapsed set.
      if (datasets.length > 0) {
        const pp = await postProcessDatasets(
          datasets,
          requirements,
          combinedQuery,
          llm,
          !!input.include_superseded_assets,
        );
        datasets = pp.datasets;
        dropped.push(...pp.dropped);
        warnings.push(...pp.warnings);
      }

      // ── [5] HTTP probe → verification_status (annotates, never filters) ─────
      if (datasets.length > 0) {
        try {
          verificationTally = await verifyDatasetAssets(datasets, raw_sources);
        } catch (err) {
          warnings.push(
            `verification step failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // ── [6] Interaction detection (D7) + [7] multi-format capture (D8) ────
        if (verificationTally.interaction > 0) {
          try {
            await attachInteractions(datasets);
          } catch (err) {
            warnings.push(
              `interaction detection failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      } // end haveCandidates

      // ── §5 Data-page extraction (page carries data inline; NOT saved as file) ──
      if (dataPageSources.length > 0) {
        try {
          data_pages = await extractDataPages(
            dataPageSources,
            requirements,
            combinedQuery,
            llm,
          );
        } catch (err) {
          warnings.push(
            `data-page extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  const result: AssetDiscoveryResult = {
    query: combinedQuery,
    generated_at: new Date().toISOString(),
    requirements,
    stats: {
      queries,
      candidates_found,
      sources_scraped: raw_sources.length,
      catalog_pages_fetched,
      structuring_model: structuringModel,
      verification: verificationTally,
    },
    raw_sources: input.include_sources
      ? raw_sources
      : raw_sources.map((s) => ({ ...s, content: '' })),
    datasets,
    data_pages,
    dropped,
    warnings,
  };

  if (input.include_sources) {
    result.sources = raw_sources.map((s) => ({
      content: s.content,
      metadata: { url: s.url, title: s.title },
    }));
  }

  return result;
}
