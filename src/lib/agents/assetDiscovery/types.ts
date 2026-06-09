/**
 * Phase 2c — Unified Asset Discovery types.
 *
 * Shared contract for the structured asset-discovery pipeline. These types grow
 * milestone-by-milestone; Milestone 1 only populates the search/scrape/raw-candidate
 * fields (no LLM, no verification). Later milestones fill datasets[], grounding,
 * verification_status, interaction{}, requirement_ids[], etc.
 *
 * The pipeline is deterministic: search -> rank -> MANDATORY catalog scrape ->
 * per-source raw candidates. It does NOT go through the agentic researcher loop
 * (catalog scrape must not be left to agent discretion — spec §3 step 1).
 */
import { ModelWithProvider } from '@/lib/models/types';
import { SearchSources } from '@/lib/agents/search/types';

export type Requirement = {
  id: string;
  text: string;
};

export type AssetDiscoveryInput = {
  /** One of requirements[] or query is required. */
  requirements?: Requirement[];
  query?: string;
  /** Optional seed URLs to force-scrape (always included as catalog candidates). */
  urls?: string[];
  sources?: SearchSources[];
  optimizationMode?: 'speed' | 'balanced' | 'quality';
  /** Top-N candidate source URLs to scrape. */
  maxSources?: number;
  history?: Array<[string, string]>;
  /** false (default) => superseded_versions carry metadata only (lean). */
  include_superseded_assets?: boolean;
  /** true => echo scraped sources[] in the response for audit/debug. */
  include_sources?: boolean;
  chatModel?: ModelWithProvider;
  embeddingModel?: ModelWithProvider;
  systemInstructions?: string;
};

export type SourceClassification = 'asset_host' | 'data_page' | 'navigation';

/** A download-shaped link found verbatim on a scraped page (pre-verification). */
export type RawCandidateAsset = {
  label: string;
  url: string;
  /** Original href before normalization (CMS redirect routes); used by the verifier. */
  sourceHref?: string;
  source_page: string;
};

export type CatalogLink = {
  label: string;
  url: string;
};

/** One scraped source page with its raw extracted candidates (Milestone 1 output). */
export type RawSource = {
  url: string;
  title: string;
  classification: SourceClassification;
  /** Trust score from trustedSources.ts (higher = more authoritative). */
  trust_score: number;
  /** True when this URL was added by the mandatory catalog-scrape expansion. */
  is_catalog: boolean;
  content_length: number;
  content_preview: string;
  /** Full cleaned content — kept internally; echoed in response only when include_sources. */
  content: string;
  candidate_assets: RawCandidateAsset[];
  catalog_links: CatalogLink[];
  error?: string;
};

export type DroppedEntry = {
  url?: string;
  dataset_family?: string;
  version?: string;
  reason: string;
};

/** Milestone-1 response. datasets[]/data_pages[] arrive in later milestones. */
export type AssetDiscoveryResult = {
  query: string;
  generated_at: string;
  requirements: Requirement[];
  stats: {
    queries: string[];
    candidates_found: number;
    sources_scraped: number;
    catalog_pages_fetched: string[];
    structuring_model?: string | null;
    verification?: { verified: number; interaction: number; unverified: number };
  };
  raw_sources: RawSource[];
  datasets: unknown[];
  data_pages: unknown[];
  sources?: Array<{ content: string; metadata: { url: string; title: string } }>;
  dropped: DroppedEntry[];
  warnings: string[];
};
