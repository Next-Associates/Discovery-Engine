import { JSDOM } from 'jsdom';

export type ExtractedLink = {
  label: string;
  url: string;
  /** Original href/onclick value before normalization (needed for CMS redirect routes). */
  sourceHref?: string;
};

const SKIP_SCHEMES = /^(javascript:|mailto:|tel:|#)/i;

const ONCLICK_PATTERNS = [
  /urchinTracker\s*\(\s*['"]([^'"]+)['"]/i,
  /Start\s*\(\s*['"]([^'"]+)['"]/i,
  /window\.open\s*\(\s*['"]([^'"]+)['"]/i,
  /location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
  /download\s*\(\s*['"]([^'"]+)['"]/i,
];

const HTML_ASSET_URL_PATTERN =
  /https?:\/\/[^\s"'<>]+?\.(?:zip|gpkg|shp|geojson|csv|pdf|tar|gz|7z|kmz|tiff?|tif)(?:\?[^\s"'<>]*)?/gi;

/** True when href was not normalized (e.g. WordPress `/http//host/path` routes that 500). */
export function isMalformedEmbeddedUrl(url: string): boolean {
  return /\/https?\/\//i.test(url);
}

/** WordPress sites sometimes emit broken hrefs like `/http//host/path`. */
export function unwrapEmbeddedAbsoluteUrl(url: string): string {
  const embedded = url.match(/https?\/\/([^?\s#]+)/i);
  if (embedded && /\/https?\/\//i.test(url)) {
    return `https://${embedded[1]}`;
  }
  return url;
}

export function resolveUrl(rawUrl: string, baseUrl: string): string | null {
  let trimmed = unwrapEmbeddedAbsoluteUrl(rawUrl.trim());
  if (!trimmed || SKIP_SCHEMES.test(trimmed)) return null;

  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return null;
  }
}

function extractUrlsFromOnclick(onclick: string): string[] {
  const urls: string[] = [];

  for (const pattern of ONCLICK_PATTERNS) {
    const match = onclick.match(pattern);
    if (match?.[1]) urls.push(match[1]);
  }

  return urls;
}

export function extractLinksFromHtml(
  html: string,
  baseUrl: string,
): ExtractedLink[] {
  const dom = new JSDOM(html, { url: baseUrl });
  const document = dom.window.document;

  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  const addLink = (rawUrl: string, label: string) => {
    const sourceHref = rawUrl.trim();
    const resolved = resolveUrl(rawUrl, baseUrl);
    if (!resolved) return;

    const key = resolved.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    links.push({
      label: label.replace(/\s+/g, ' ').trim() || resolved,
      url: resolved,
      sourceHref:
        sourceHref !== resolved || isMalformedEmbeddedUrl(sourceHref)
          ? sourceHref
          : undefined,
    });
  };

  document.querySelectorAll('a').forEach((anchor) => {
    const label = anchor.textContent ?? '';
    const href = anchor.getAttribute('href') ?? '';
    const onclick = anchor.getAttribute('onclick') ?? '';

    if (href && !SKIP_SCHEMES.test(href) && href !== '#') {
      addLink(href, label);
    }

    for (const url of extractUrlsFromOnclick(onclick)) {
      addLink(url, label);
    }
  });

  document.querySelectorAll('[onclick]').forEach((el) => {
    const onclick = el.getAttribute('onclick') ?? '';
    const label = el.textContent ?? '';

    for (const url of extractUrlsFromOnclick(onclick)) {
      addLink(url, label);
    }
  });

  // Download dropdowns: a <select> whose <option value="http…"> IS the download
  // URL, triggered by onclick window.open(select.value). The URLs live in the
  // static HTML — no click needed. (Country/other dropdowns have non-URL values
  // and are skipped.)
  document.querySelectorAll('select').forEach((select) => {
    const selName = select.getAttribute('name') || select.getAttribute('id') || '';
    const isDownloadSel = /format|download|export|output/i.test(selName);
    select.querySelectorAll('option').forEach((opt) => {
      const val = opt.getAttribute('value') ?? '';
      if (!/^https?:\/\//i.test(val)) return;
      const optLabel = (opt.textContent ?? '').trim();
      const label = isDownloadSel && optLabel ? `${optLabel} (download)` : optLabel || 'Download option';
      addLink(val, label);
    });
  });

  return links;
}

/** Scan full HTML for absolute asset URLs (CDN mirrors, script literals, etc.). */
export function extractAssetUrlsFromHtmlSource(
  html: string,
  baseUrl: string,
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(HTML_ASSET_URL_PATTERN)) {
    const raw = match[0];
    const resolved = resolveUrl(raw, baseUrl);
    if (!resolved) continue;

    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    links.push({
      label: 'Asset URL in page source',
      url: resolved,
      sourceHref: raw !== resolved ? raw : undefined,
    });
  }

  return links;
}

export function formatLinksSection(links: ExtractedLink[]): string {
  if (links.length === 0) return '';

  const lines = links.map(
    (link) => `- ${link.label}: ${link.url}`,
  );

  return `## Catalog / navigation links (pages only — not direct file downloads)\n${lines.join('\n')}`;
}

export type VerifiedDownload = {
  label: string;
  url: string;
  status?: number;
};

export type InteractionRequiredDownload = {
  label: string;
  url: string;
  status?: number;
};

export function formatVerifiedLinksSection(
  verified: VerifiedDownload[],
): string {
  if (verified.length === 0) return '';

  const lines = verified.map(
    (v) => `- ${v.label}: ${v.url} (verified HTTP ${v.status ?? 200})`,
  );

  return `## Verified download links (live HTTP check passed — ONLY these may be cited as direct downloads)\n${lines.join('\n')}`;
}

export function formatInteractionRequiredLinksSection(
  downloads: InteractionRequiredDownload[],
): string {
  if (downloads.length === 0) return '';

  const lines = downloads.map(
    (d) =>
      `- ${d.label}: ${d.url} (HTTP ${d.status ?? 200}, requires user interaction)`,
  );

  return `## Downloads requiring user interaction (reachable asset URL — gated form/login; cite these as official assets, NOT as verified direct downloads)\n${lines.join('\n')}`;
}

export function formatSourcePagesSection(
  pages: { url: string; title?: string }[],
): string {
  if (pages.length === 0) return '';

  const lines = pages.map(
    (p) => `- ${p.title?.replace(/\s+/g, ' ').trim() || 'Source page'}: ${p.url}`,
  );

  return `## Source pages (catalog — cite when no verified direct downloads)\n${lines.join('\n')}`;
}

export function formatUnverifiedDownloadsNote(): string {
  return `## Direct downloads not verified\nAsset-like links were found on the page but none returned a direct file (HTTP 200 binary) nor a reachable gated asset URL. Do not list unverified or broken file URLs from any source. Cite verified downloads, interaction-required downloads, and/or source/catalog pages above.`;
}

export function mergeLinks(...groups: ExtractedLink[][]): ExtractedLink[] {
  const seen = new Set<string>();
  const merged: ExtractedLink[] = [];

  for (const group of groups) {
    for (const link of group) {
      const key = link.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(link);
    }
  }

  return merged;
}
