/**
 * Phase 2c — LLM structured extraction (spec §3 step 3) + grounding guard (§4).
 *
 * Consolidated structuring: one LLM call over the union of per-source candidate
 * URLs + content excerpts, producing datasets[] grouped by family/version. The LLM
 * reads source CONTENT ONLY (this pipeline never produces prose, so there is no
 * writer message to leak). Every emitted asset URL is then grounding-checked: it
 * must appear verbatim (normalized) in some source's content, else it is dropped
 * and logged to warnings[].
 *
 * Version selection, requirement filtering, dedup-across-sources, verification, and
 * interaction detection are LATER milestones — this module only structures + grounds.
 */
import z from 'zod';
import BaseLLM from '@/lib/models/base/llm';
import { RawSource, Requirement } from './types';
import { buildGroundingHaystack, isGrounded, normalizeUrlForMatch } from './grounding';

const MAX_CONTENT_EXCERPT = 4000;
const MAX_CANDIDATE_URLS = 250;
const STRUCTURE_MAX_TOKENS = Number(
  process.env.ASSET_DISCOVERY_STRUCTURE_MAX_TOKENS ?? 8000,
);

const assetSchema = z.object({
  format: z
    .string()
    .describe('File format, lowercase (e.g. shapefile, gpkg, kml, geojson, csv, pdf). Use "unknown" if unclear.'),
  label: z.string().describe('Human label for this asset, copied/derived from the page.'),
  url: z
    .string()
    .describe('The download URL, copied VERBATIM from the provided content. Never invent or alter.'),
});

const datasetSchema = z.object({
  dataset_family: z
    .string()
    .describe('The dataset family/product line, version-independent (e.g. "World EEZ", "World 12NM").'),
  dataset_name: z.string().describe('Specific dataset name including version if known (e.g. "World EEZ v12").'),
  version: z.string().nullable().describe('Version string if present (e.g. "v12"), else null.'),
  release_date: z.string().nullable().describe('Release/publish date if stated, else null.'),
  provider: z.string().nullable().describe('Publishing organisation if stated, else null.'),
  source_page: z.string().describe('The page URL this dataset was found on (from the provided sources).'),
  description: z.string().describe('Short factual description from the content. No marketing fluff.'),
  assets: z.array(assetSchema).describe('Download assets for this dataset, one per format/version variant.'),
});

const structureSchema = z.object({
  datasets: z.array(datasetSchema),
});

const SYSTEM_PROMPT = `You are a data-asset structuring engine. You convert scraped catalog/download pages into a clean JSON list of datasets and their downloadable assets.

HARD RULES:
- Use ONLY the information in the provided <sources>. Do not use prior knowledge.
- Copy every URL VERBATIM from the content. Never invent, guess, shorten, or "fix" a URL. If a URL is not in the content, do not output it.
- Extract the dataset families that are relevant to the user's requirement, INCLUDING ALL their versions. Do not enumerate unrelated product lines, but when in doubt include a family. A later deterministic step refines relevance and selects the latest version.
- Group assets by DATASET FAMILY (version-independent product line) and then by VERSION. Different families (e.g. EEZ vs 12NM vs 24NM vs High Seas) are SEPARATE datasets. Different versions of the same family are SEPARATE dataset entries sharing the same dataset_family.
- One asset per (format, version) — if a dataset offers multiple formats (shapefile, gpkg, kml), list each as its own asset with the correct url.
- Prefer the official/catalog source_page the URL was found on.
- Output STRICT JSON matching the schema. No prose, no markdown.`;

function buildContext(sources: RawSource[]): string {
  // Prioritize asset-bearing + catalog pages; include their candidate URL lists in full.
  const ordered = [...sources].sort((a, b) => {
    const score = (s: RawSource) =>
      (s.candidate_assets.length > 0 ? 2 : 0) + (s.is_catalog ? 1 : 0);
    return score(b) - score(a);
  });

  let urlBudget = MAX_CANDIDATE_URLS;
  const blocks = ordered.map((s, i) => {
    const urls = s.candidate_assets.slice(0, Math.max(0, urlBudget));
    urlBudget -= urls.length;
    const urlList =
      urls.length > 0
        ? urls.map((a) => `  - ${a.label || 'asset'}: ${a.url}`).join('\n')
        : '  (no asset-like links found on this page)';
    const excerpt = (s.content || '').slice(0, MAX_CONTENT_EXCERPT);
    return `<source index="${i + 1}" url="${s.url}" title="${s.title}" classification="${s.classification}">
CANDIDATE ASSET URLS (copy verbatim):
${urlList}

CONTENT EXCERPT:
${excerpt}
</source>`;
  });

  return blocks.join('\n\n');
}

export type StructureResult = {
  datasets: z.infer<typeof datasetSchema>[] & Array<Record<string, any>>;
  warnings: string[];
  dropped: Array<{ url?: string; dataset_family?: string; reason: string }>;
};

export async function structureDatasets(
  sources: RawSource[],
  requirements: Requirement[],
  query: string,
  llm: BaseLLM<any>,
): Promise<StructureResult> {
  const warnings: string[] = [];
  const dropped: StructureResult['dropped'] = [];

  const reqText = requirements.length
    ? requirements.map((r) => `- (${r.id}) ${r.text}`).join('\n')
    : `- ${query}`;

  const context = buildContext(sources);
  const userContent = `User requirements:\n${reqText}\n\nStructure the datasets and assets found in these sources.\n\n<sources>\n${context}\n</sources>`;

  // Reasoning models occasionally return an empty object (truncation / hidden-token
  // burn). Retry once on empty before giving up — candidates exist, so empty is wrong.
  let raw: z.infer<typeof structureSchema> = { datasets: [] };
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      raw = await llm.generateObject<typeof structureSchema>({
        schema: structureSchema,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        options: { temperature: 0, maxTokens: STRUCTURE_MAX_TOKENS },
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        warnings.push(
          `structuring LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { datasets: [], warnings, dropped };
      }
      continue;
    }
    if ((raw?.datasets?.length ?? 0) > 0) break;
    if (attempt < MAX_ATTEMPTS) {
      warnings.push('structuring returned 0 datasets — retrying');
    }
  }

  // ── Grounding guard ────────────────────────────────────────────────────────
  const haystack = buildGroundingHaystack(sources);
  const datasets: Array<Record<string, any>> = [];

  for (const ds of raw.datasets ?? []) {
    const seenUrls = new Set<string>();
    const groundedAssets = [];
    for (const a of ds.assets ?? []) {
      if (!a.url) continue;
      const key = normalizeUrlForMatch(a.url);
      if (seenUrls.has(key)) continue;
      if (!isGrounded(a.url, haystack)) {
        warnings.push(`grounding-dropped: ${a.url} (not verbatim in any source)`);
        dropped.push({ url: a.url, reason: 'grounding_failed' });
        continue;
      }
      seenUrls.add(key);
      groundedAssets.push({
        format: a.format || 'unknown',
        label: a.label || a.url,
        url: a.url,
        found_in_source: true,
        source_page: ds.source_page,
      });
    }

    if (groundedAssets.length === 0) {
      dropped.push({
        dataset_family: ds.dataset_family,
        reason: 'no_grounded_assets',
      });
      continue;
    }

    datasets.push({
      dataset_family: ds.dataset_family,
      dataset_name: ds.dataset_name,
      version: ds.version ?? null,
      release_date: ds.release_date ?? null,
      provider: ds.provider ?? null,
      source_page: ds.source_page,
      description: ds.description ?? '',
      metadata: {},
      assets: groundedAssets,
    });
  }

  return { datasets: datasets as any, warnings, dropped };
}
