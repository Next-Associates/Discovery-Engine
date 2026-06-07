/**
 * General asset-extraction pipeline — domain-agnostic triggers and URL patterns.
 * Used by scrape, verify, and trust-ranking steps for any user query.
 */

/** Max URLs processed per scrape_url tool call (after normalizeScrapeTargets expansion). */
export const MAX_SCRAPE_URLS_PER_CALL = Number(
  process.env.MAX_SCRAPE_URLS_PER_CALL ?? 6,
);

/** Max asset-like links HTTP-verified per scraped page. */
export const MAX_VERIFY_URLS_PER_PAGE = Number(
  process.env.MAX_VERIFY_URLS_PER_PAGE ?? 24,
);

/** User query signals that require live scrape + verified URLs (not search snippets alone). */
const ASSET_INTENT_PATTERNS: RegExp[] = [
  /\bdownload\b/i,
  /\bdirect\s+url/i,
  /\basset(s)?\b/i,
  /\bdataset(s)?\b/i,
  /\bdata\s+file/i,
  /\bfile(s)?\b/i,
  /\bshapefile\b/i,
  /\bgeopackage\b/i,
  /\bgpkg\b/i,
  /\bkmz?\b/i,
  /\bgeojson\b/i,
  /\blatest\s+release/i,
  /\bofficial\s+(source|link|url|page)/i,
  /\btrusted\s+source/i,
  /\bfrom\s+the\s+(live|official)\s+(page|site)/i,
  /\brule\s+base\b/i,
  /\blegal\s+(text|framework|document)/i,
  /\btreaty\b/i,
  /\bconvention\b/i,
  /\bwhitepaper\b/i,
  /\brelease(s)?\b/i,
  /\b\.(zip|pdf|gpkg|shp|geojson|csv)\b/i,
];

/** URLs that look like downloadable or authoritative assets (any domain). */
export const ASSET_URL_PATTERNS: RegExp[] = [
  /download/i,
  /\/download[_-]?file/i,
  /\.(zip|gpkg|shp|geojson|json|xml|csv|xlsx|pdf|kmz|tar|gz|7z|docx?)(\?|#|$)/i,
  /\/data(\?|#|$)/,
  /\/releases?\//i,
  /\/assets?\//i,
  /\/files?\//i,
  /\/publications?\//i,
  /\/documents?\//i,
  /\/rest\/content\/items\/[^/]+\/data/i,
  /sharing\/rest\/content/i,
];

export function queryRequestsAssets(query: string): boolean {
  return ASSET_INTENT_PATTERNS.some((p) => p.test(query));
}

const FILE_EXTENSION =
  /\.(zip|gpkg|shp|geojson|json|xml|csv|xlsx|pdf|kmz|tar|gz|7z|docx?|tiff?|tif)(\?|#|$)/i;

export function isAssetLikeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;

    if (FILE_EXTENSION.test(path)) return true;
    if (/\/download[_-]?file/i.test(path)) return true;
    // Singular /download/ paths (files), not plural /downloads/ (catalog indexes)
    if (/\/download\//i.test(path) && !/\/downloads\//i.test(path)) return true;
    if (/\/rest\/content\/items\/[^/]+\/data/i.test(path)) return true;
    if (/sharing\/rest\/content/i.test(path)) return true;

    return false;
  } catch {
    return ASSET_URL_PATTERNS.some((p) => p.test(url));
  }
}

/**
 * Expand scrape targets when search returns stale aliases or guessed file paths.
 * Domain-agnostic — prefers catalog/index pages over guessed direct file paths.
 */
export function normalizeScrapeTargets(url: string): string[] {
  const targets = new Set<string>([url]);

  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const path = parsed.pathname;

    if (/\/downloads\.html$/i.test(path)) {
      targets.add(`${origin}/downloads.php`);
      targets.add(`${origin}/downloads`);
    }

    if (/^\/downloads\/[^/]+\.(zip|gpkg|shp|tar|gz|geojson|pdf)$/i.test(path)) {
      targets.add(`${origin}/downloads.php`);
      targets.add(`${origin}/downloads`);
      targets.add(`${origin}/download`);
    }

    // Direct file under /download/ — also try common catalog indexes on the same host
    if (/^\/download\/[^/]+\.(zip|gpkg|shp|tar|gz|geojson|pdf)$/i.test(path)) {
      targets.add(`${origin}/downloads`);
      targets.add(`${origin}/downloads/`);
    }
  } catch {
    // keep original url only
  }

  return [...targets];
}

export const ASSET_RESEARCH_RULES = `
### Asset and URL extraction (all queries)
When the user wants **assets**, **download links**, **datasets**, **files**, **direct URLs**, **official/trusted sources**, **releases**, **rule bases**, **legal texts**, or **portal items** — follow this pipeline for **any topic and any website**:

1. **Search** to discover candidate publisher pages (official site, docs, downloads, releases, data portal, GitHub releases, etc.).
2. **Scrape** those live pages with \`scrape_url\` — up to ${MAX_SCRAPE_URLS_PER_CALL} URLs per call (catalog/docs/download pages, not only the homepage). Search snippets and model memory are often outdated.
3. **Verify** asset links in the context of the scraped page (session cookies + Referer), follow redirects to the final CDN/file URL, and cite only links that return HTTP 200.
4. **Extract** URLs only from tool output sections: "Verified download links", "Source pages (catalog)", and "Catalog / navigation links".
4. **Prefer trusted publishers** (government, intergovernmental, official project domains) over mirrors, blogs, and aggregators when the same asset appears twice.
5. **Never invent URLs** — do not guess file paths unless they appear on a scraped page and pass HTTP verification.

Portal pages (ArcGIS, Hugging Face, GitHub releases, Zenodo, etc.): scrape the item/release URL returned by search — the tool resolves some portals via API when HTML is JavaScript-only.

If search returns a suspected stale file URL, scrape the site's downloads/docs/releases index for the current link.
`;

export const ASSET_WRITER_RULES = `
### Asset URL output (all queries)
- **Never invent URLs.** Only use URLs that appear verbatim in context.
- **Direct download / file URLs**: list ONLY URLs from the **"Verified download links"** section (HTTP 200 confirmed). Never label a URL as verified unless it appears there.
- **Broken or unverified assets**: if context has **"Direct downloads not verified"** or no verified section, do **not** list direct file URLs — not even if they appear in search snippets, catalog link text, or model memory. Cite only **"Source pages (catalog)"** entries.
- Do not construct paths from filenames — publisher paths change and stale URLs are common on any site.
- When the user asks for **assets**, **downloads**, **datasets**, **files**, **direct links**, or **trusted/official sources**, add **"## Authoritative source URLs"** listing verified downloads when available, otherwise the official catalog/source pages from context.
- Only cite a direct file URL when it appears under **Verified download links** with a confirmed HTTP status.
`;

export const ASSET_EXTRACTOR_RULES = `
7. **URL and link integrity**: When the query asks for assets, downloads, direct URLs, file paths, datasets, releases, or official sources, copy every URL exactly as it appears in the scraped data. Never rewrite, shorten, infer, or construct URLs. Preserve the full "Verified download links", "Source pages (catalog)", and "Catalog / navigation links" sections verbatim if present.
8. **Prefer live links over prose**: If both narrative text and a links section exist, treat the links sections as authoritative for URLs.
9. **Any domain**: Apply the same rules regardless of website — extract href, onclick, and portal API links as-is.
`;
