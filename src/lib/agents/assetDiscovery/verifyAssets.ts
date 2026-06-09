/**
 * Phase 2c — HTTP probe → verification_status (spec §3 step 5).
 *
 * Reuses verifyDownloadUrls (warm page session + Referer + redirect follow). Status
 * ONLY annotates — it never filters (D3). Mapping:
 *   - live 2xx file payload        -> verified_200
 *   - 2xx HTML on an asset URL      -> requires_interaction (gated form/login)
 *   - inconclusive / non-2xx / skip -> unverified
 *
 * For requires_interaction we record the real HTTP code observed (e.g. 200 for the
 * license form) in http_status — don't leave it null just because it isn't a file.
 */
import { verifyDownloadUrls } from '@/lib/utils/verifyUrls';
import { RawSource } from './types';

export type VerificationStatus = 'verified_200' | 'requires_interaction' | 'unverified';

type AssetLike = {
  url: string;
  source_page?: string;
  verification_status?: VerificationStatus;
  http_status?: number | null;
  [k: string]: any;
};

type DatasetLike = { assets?: AssetLike[]; source_page?: string; [k: string]: any };

const VERIFY_LIMIT = Number(process.env.ASSET_DISCOVERY_VERIFY_LIMIT ?? 80);

/**
 * Probe every asset URL across all datasets and annotate verification_status +
 * http_status in place. Grouped by referer page so the session warm-up (cookies)
 * matches how the link was found. Recovers sourceHref from raw candidate links.
 */
export async function verifyDatasetAssets(
  datasets: DatasetLike[],
  sources: RawSource[],
): Promise<{ verified: number; interaction: number; unverified: number }> {
  // url -> sourceHref (CMS redirect route hint) from the originally extracted links.
  const hrefByUrl = new Map<string, string | undefined>();
  for (const s of sources) {
    for (const c of s.candidate_assets) {
      if (!hrefByUrl.has(c.url)) hrefByUrl.set(c.url, c.sourceHref);
    }
  }

  // Collect unique (url, referer) probes, grouped by referer for session warming.
  const byReferer = new Map<string, Map<string, string | undefined>>();
  for (const ds of datasets) {
    for (const a of ds.assets ?? []) {
      if (!a.url) continue;
      const referer = a.source_page || ds.source_page || '';
      if (!byReferer.has(referer)) byReferer.set(referer, new Map());
      const g = byReferer.get(referer)!;
      if (!g.has(a.url)) g.set(a.url, hrefByUrl.get(a.url));
    }
  }

  // Verify each referer group; build a url -> status map.
  const statusByUrl = new Map<string, { status: VerificationStatus; http: number | null }>();
  for (const [referer, urls] of byReferer) {
    const inputs = [...urls.entries()].map(([url, sourceHref]) => ({ url, sourceHref }));
    const verifications = await verifyDownloadUrls(
      inputs,
      Math.max(VERIFY_LIMIT, inputs.length),
      referer ? { referer } : undefined,
    );
    verifications.forEach((v, i) => {
      const url = inputs[i].url;
      let status: VerificationStatus;
      if (v.ok) status = 'verified_200';
      else if (v.requiresInteraction) status = 'requires_interaction';
      else status = 'unverified';
      statusByUrl.set(url, { status, http: v.status ?? null });
    });
  }

  // Annotate in place + tally.
  let verified = 0;
  let interaction = 0;
  let unverified = 0;
  for (const ds of datasets) {
    for (const a of ds.assets ?? []) {
      const r = statusByUrl.get(a.url) ?? { status: 'unverified' as const, http: null };
      a.verification_status = r.status;
      a.http_status = r.http;
      if (r.status === 'verified_200') verified++;
      else if (r.status === 'requires_interaction') interaction++;
      else unverified++;
    }
  }

  return { verified, interaction, unverified };
}
