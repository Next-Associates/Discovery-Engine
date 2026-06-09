/**
 * Phase 2c — post-processing orchestrator (spec §3 steps 8–10).
 * Deterministic logic lives in ./postProcessCore (unit-tested). This file adds the
 * only non-deterministic part — an LLM relevance judgement over family names — and
 * wires dedup → requirement filter → version select together.
 */
import BaseLLM from '@/lib/models/base/llm';
import z from 'zod';
import { Requirement, DroppedEntry } from './types';
import {
  Dataset,
  dedupDatasets,
  applyFamilyMatches,
  versionSelect,
  propagateRequirementIds,
} from './postProcessCore';

const filterSchema = z.object({
  matches: z.array(
    z.object({
      dataset_family: z.string(),
      requirement_ids: z.array(z.string()),
      reason: z.string(),
    }),
  ),
});

/** LLM relevance judgement → map of lowercased family -> satisfied requirement ids. */
async function judgeFamilies(
  families: string[],
  datasets: Dataset[],
  reqList: Requirement[],
  llm: BaseLLM<any>,
): Promise<Map<string, string[]>> {
  const familyContext = families
    .map((f) => {
      const ds = datasets.find((d) => d.dataset_family === f)!;
      return `- family="${f}" | example="${ds.dataset_name}" | desc="${(ds.description || '').slice(0, 160)}"`;
    })
    .join('\n');

  const result = await llm.generateObject<typeof filterSchema>({
    schema: filterSchema,
    messages: [
      {
        role: 'system',
        content: `You decide which dataset FAMILIES satisfy a user's requirements. Be inclusive of clearly-relevant families and exclude clearly-unrelated ones. Judge by meaning, not exact words. Return ONLY families that satisfy at least one requirement, each with the requirement id(s) it satisfies and a one-line reason. Families you omit are treated as not relevant. Output strict JSON.`,
      },
      {
        role: 'user',
        content: `Requirements:\n${reqList.map((r) => `- (${r.id}) ${r.text}`).join('\n')}\n\nCandidate dataset families:\n${familyContext}`,
      },
    ],
    options: { temperature: 0, maxTokens: 2000 },
  });

  const map = new Map<string, string[]>();
  for (const m of result.matches ?? []) {
    map.set(m.dataset_family.toLowerCase(), m.requirement_ids ?? []);
  }
  return map;
}

async function requirementFilter(
  datasets: Dataset[],
  requirements: Requirement[],
  query: string,
  llm: BaseLLM<any>,
): Promise<{ kept: Dataset[]; dropped: DroppedEntry[]; warnings: string[] }> {
  const warnings: string[] = [];
  const families = [...new Set(datasets.map((d) => d.dataset_family))];
  const reqList = requirements.length ? requirements : [{ id: 'query', text: query }];

  // Single family + no requirement to discriminate on → nothing to filter.
  if (families.length <= 1 && requirements.length === 0 && !query) {
    return { kept: datasets, dropped: [], warnings };
  }

  let matchByFamily: Map<string, string[]>;
  try {
    matchByFamily = await judgeFamilies(families, datasets, reqList, llm);
  } catch (err) {
    warnings.push(
      `requirement filter LLM failed (${err instanceof Error ? err.message : String(err)}) — keeping all families`,
    );
    return { kept: datasets, dropped: [], warnings };
  }

  const { kept, dropped } = applyFamilyMatches(
    datasets,
    matchByFamily,
    reqList.map((r) => r.id),
  );

  // Fail-open: never return empty when we had datasets (better to keep than wrongly drop all).
  if (kept.length === 0 && datasets.length > 0) {
    warnings.push('requirement filter matched no families — keeping all (fail-open)');
    return { kept: datasets, dropped: [], warnings };
  }
  return { kept, dropped, warnings };
}

export async function postProcessDatasets(
  datasets: Dataset[],
  requirements: Requirement[],
  query: string,
  llm: BaseLLM<any>,
  includeSupersededAssets: boolean,
): Promise<{ datasets: Dataset[]; dropped: DroppedEntry[]; warnings: string[] }> {
  const reqList = requirements.length ? requirements : [{ id: 'query', text: query }];
  const deduped = dedupDatasets(datasets);
  const filtered = await requirementFilter(deduped, requirements, query, llm);
  const versioned = versionSelect(filtered.kept, includeSupersededAssets);
  // [11] D9 — guarantee requirement_ids[] on datasets, assets, superseded entries.
  propagateRequirementIds(versioned.selected, reqList.map((r) => r.id));
  return {
    datasets: versioned.selected,
    dropped: [...filtered.dropped, ...versioned.dropped],
    warnings: filtered.warnings,
  };
}
