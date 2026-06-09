/**
 * Phase 2c — deterministic per-source scrape + raw candidate extraction.
 *
 * Reuses the same building blocks as the agentic researcher (Scraper, extractLinks,
 * assetPipeline) but WITHOUT the agent loop or any LLM call. Milestone 1: scrape a
 * page, classify it, and list the asset-like links found verbatim on it. Verification
 * (HTTP probe), grounding, and LLM structuring are added in later milestones.
 */
import Scraper from '@/lib/scraper';
import { isAssetLikeUrl } from '@/lib/utils/assetPipeline';
import { type ExtractedLink } from '@/lib/utils/extractLinks';
import { getSourceTrustScore } from '@/lib/utils/trustedSources';
import {
  RawSource,
  RawCandidateAsset,
  CatalogLink,
  SourceClassification,
} from './types';

const PREVIEW_CHARS = 600;

function classifySource(
  candidateAssets: RawCandidateAsset[],
  contentLength: number,
): SourceClassification {
  // Page hosts downloadable asset URLs -> asset_host.
  if (candidateAssets.length > 0) return 'asset_host';
  // Substantial inline content with no asset links -> the page itself is the data.
  if (contentLength >= 600) return 'data_page';
  // Thin page, no assets -> navigation/landing.
  return 'navigation';
}

/**
 * Scrape one URL and return its raw candidates. Never throws — failures are
 * captured in RawSource.error so one bad page can't sink the run.
 */
export async function scrapeSource(
  url: string,
  isCatalog: boolean,
): Promise<RawSource> {
  const trustScore = getSourceTrustScore(url);

  try {
    const scraped = await Scraper.scrape(url);
    const extractedLinks: ExtractedLink[] = scraped.extractedLinks ?? [];

    const candidate_assets: RawCandidateAsset[] = extractedLinks
      .filter((link) => isAssetLikeUrl(link.url))
      .map((link) => ({
        label: link.label,
        url: link.url,
        sourceHref: link.sourceHref,
        source_page: url,
      }));

    const catalog_links: CatalogLink[] = extractedLinks
      .filter((link) => !isAssetLikeUrl(link.url))
      .map((link) => ({ label: link.label, url: link.url }));

    const cleanContent = scraped.content ?? '';
    // Classify on the cleaned page text (before we append link sections).
    const classification = classifySource(candidate_assets, cleanContent.length);

    // Append the extracted links to content so every candidate URL appears VERBATIM
    // in source content (matches scrapeURL.ts convention). This makes content the
    // single, auditable source of truth for the grounding guard — consumers can
    // re-verify grounding from the echoed sources[] alone (spec §4.2).
    let content = cleanContent;
    if (candidate_assets.length > 0) {
      content +=
        '\n\n## Asset links found on page\n' +
        candidate_assets.map((a) => `- ${a.label || 'asset'}: ${a.url}`).join('\n');
    }
    if (catalog_links.length > 0) {
      content +=
        '\n\n## Catalog / navigation links (pages only — not direct file downloads)\n' +
        catalog_links.map((c) => `- ${c.label || 'link'}: ${c.url}`).join('\n');
    }

    return {
      url,
      title: scraped.title || url,
      classification,
      trust_score: trustScore,
      is_catalog: isCatalog,
      content_length: content.length,
      content_preview: cleanContent.slice(0, PREVIEW_CHARS),
      content,
      candidate_assets,
      catalog_links,
    };
  } catch (error) {
    return {
      url,
      title: `Error scraping ${url}`,
      classification: 'navigation',
      trust_score: trustScore,
      is_catalog: isCatalog,
      content_length: 0,
      content_preview: '',
      content: '',
      candidate_assets: [],
      catalog_links: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
