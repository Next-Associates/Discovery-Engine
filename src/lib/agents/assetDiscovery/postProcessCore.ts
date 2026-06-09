/**
 * Phase 2c — deterministic post-processing core (no LLM, no @/ imports).
 *
 * Pure functions for dedup, version comparison/selection, and applying a
 * family-relevance map. Kept import-light (only ./grounding) so they can be
 * unit-tested directly with `npx tsx` without a running server or model.
 */
import { normalizeUrlForMatch } from './grounding';

export type Asset = Record<string, any>;
export type Dataset = {
  dataset_family: string;
  dataset_name: string;
  version: string | null;
  release_date: string | null;
  provider: string | null;
  source_page: string;
  description: string;
  metadata: Record<string, any>;
  assets: Asset[];
  requirement_ids?: string[];
  is_latest?: boolean;
  superseded_versions?: any[];
  [k: string]: any;
};

export type Dropped = {
  url?: string;
  dataset_family?: string;
  version?: string;
  reason: string;
};

// ── [8] Dedup ────────────────────────────────────────────────────────────────
export function dedupAssets(assets: Asset[]): Asset[] {
  const seen = new Set<string>();
  const out: Asset[] = [];
  for (const a of assets) {
    if (!a?.url) continue;
    const key = `${(a.format || '').toLowerCase()}|${normalizeUrlForMatch(a.url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export function dedupDatasets(datasets: Dataset[]): Dataset[] {
  const byKey = new Map<string, Dataset>();
  for (const ds of datasets) {
    const key = `${(ds.dataset_family || '').toLowerCase()}|${(ds.version || '').toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...ds, assets: dedupAssets(ds.assets) });
      continue;
    }
    existing.assets = dedupAssets([...existing.assets, ...ds.assets]);
    if (!existing.description && ds.description) existing.description = ds.description;
    if (!existing.release_date && ds.release_date) existing.release_date = ds.release_date;
    if (!existing.provider && ds.provider) existing.provider = ds.provider;
  }
  return [...byKey.values()];
}

// ── [9b] Apply family-relevance map (deterministic part of the filter) ────────
/**
 * matchByFamily: lowercased family -> requirement ids it satisfies (may be []).
 * Families absent from the map are dropped as requirement_mismatch.
 */
export function applyFamilyMatches(
  datasets: Dataset[],
  matchByFamily: Map<string, string[]>,
  fallbackIds: string[],
): { kept: Dataset[]; dropped: Dropped[] } {
  const kept: Dataset[] = [];
  const dropped: Dropped[] = [];
  const droppedFamilies = new Set<string>();
  for (const ds of datasets) {
    const ids = matchByFamily.get(ds.dataset_family.toLowerCase());
    if (ids) {
      ds.requirement_ids = ids.length ? ids : fallbackIds;
      kept.push(ds);
    } else if (!droppedFamilies.has(ds.dataset_family)) {
      droppedFamilies.add(ds.dataset_family);
      dropped.push({ dataset_family: ds.dataset_family, reason: 'requirement_mismatch' });
    }
  }
  return { kept, dropped };
}

// ── [11] Requirement mapping (D9) ─────────────────────────────────────────────
/**
 * Ensure every surviving dataset and each of its assets carries requirement_ids[].
 * Datasets already get ids from the requirement filter; this guarantees presence
 * (fail-open / single-family paths) and propagates to assets + superseded entries.
 */
export function propagateRequirementIds(datasets: Dataset[], fallbackIds: string[]): void {
  for (const ds of datasets) {
    const ids = ds.requirement_ids?.length ? ds.requirement_ids : fallbackIds;
    ds.requirement_ids = ids;
    for (const a of ds.assets ?? []) {
      a.requirement_ids = ids;
    }
    for (const s of ds.superseded_versions ?? []) {
      if (s && typeof s === 'object') {
        (s as any).requirement_ids = ids;
        for (const a of (s as any).assets ?? []) a.requirement_ids = ids;
      }
    }
  }
}

// ── [10] Version select (D4) ──────────────────────────────────────────────────
export function parseVersionTokens(ds: Pick<Dataset, 'version' | 'dataset_name'>): number[] | null {
  const hay = `${ds.version ?? ''} ${ds.dataset_name ?? ''}`;
  const m = hay.match(/v\.?\s*(\d+(?:\.\d+)*)/i) || hay.match(/\b(\d+(?:\.\d+)+)\b/);
  if (!m) return null;
  return m[1].split('.').map((n) => Number(n));
}

export function compareDatasetsDesc(a: Dataset, b: Dataset): number {
  const va = parseVersionTokens(a);
  const vb = parseVersionTokens(b);
  if (va && vb) {
    const len = Math.max(va.length, vb.length);
    for (let i = 0; i < len; i++) {
      const d = (vb[i] ?? 0) - (va[i] ?? 0);
      if (d !== 0) return d;
    }
  } else if (va && !vb) {
    return -1;
  } else if (!va && vb) {
    return 1;
  }
  const da = Date.parse(a.release_date ?? '');
  const db = Date.parse(b.release_date ?? '');
  if (!isNaN(da) && !isNaN(db) && da !== db) return db - da;
  return 0;
}

export function versionSelect(
  datasets: Dataset[],
  includeSupersededAssets: boolean,
): { selected: Dataset[]; dropped: Dropped[] } {
  const byFamily = new Map<string, Dataset[]>();
  for (const ds of datasets) {
    const f = ds.dataset_family;
    if (!byFamily.has(f)) byFamily.set(f, []);
    byFamily.get(f)!.push(ds);
  }

  const selected: Dataset[] = [];
  const dropped: Dropped[] = [];

  for (const [, group] of byFamily) {
    const sorted = [...group].sort(compareDatasetsDesc);
    const latest = sorted[0];
    const rest = sorted.slice(1);

    latest.is_latest = true;
    latest.superseded_versions = rest.map((s) => {
      const base = {
        version: s.version,
        release_date: s.release_date,
        source_page: s.source_page,
        dataset_name: s.dataset_name,
      };
      return includeSupersededAssets ? { ...base, assets: s.assets } : base;
    });

    for (const s of rest) {
      dropped.push({
        dataset_family: s.dataset_family,
        version: s.version ?? undefined,
        reason: 'superseded',
      });
    }
    selected.push(latest);
  }

  return { selected, dropped };
}
