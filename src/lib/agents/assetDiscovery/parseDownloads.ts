/**
 * Parsers for structured download sections emitted in scraped source content.
 *
 * Extracted from the /api/asset-discovery route so they can be unit-tested and
 * imported freely — a Next.js `route.ts` may only export route handlers
 * (GET/POST/...), so helper exports must live in a regular module.
 */
import { Chunk } from '@/lib/types';

export type StructuredDownload = {
  label: string;
  url: string;
  status: number;
  sourcePage?: string;
};

const VERIFIED_HEADER = '## Verified download links';
const INTERACTION_HEADER = '## Downloads requiring user interaction';
// `- {label}: {url} (verified HTTP {status})`
const VERIFIED_LINE =
  /^-\s*(.*?):\s*(https?:\/\/\S+?)\s*\(verified HTTP\s*(\d+)\)\s*$/i;
// `- {label}: {url} (HTTP {status}, requires user interaction)`
const INTERACTION_LINE =
  /^-\s*(.*?):\s*(https?:\/\/\S+?)\s*\(HTTP\s*(\d+),\s*requires user interaction\)\s*$/i;

function parseSectionDownloads(
  content: string,
  header: string,
  lineRe: RegExp,
  sourcePage?: string,
): StructuredDownload[] {
  if (!content || !content.includes(header)) return [];

  const out: StructuredDownload[] = [];
  const lines = content.split('\n');
  let inSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith(header)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith('## ')) break;
    if (line === '') continue;

    const m = line.match(lineRe);
    if (m) {
      out.push({
        label: m[1].trim() || m[2],
        url: m[2],
        status: Number(m[3]) || 200,
        sourcePage,
      });
    }
  }
  return out;
}

/** Pull structured verified downloads out of a single source's content. */
export function parseVerifiedDownloads(
  content: string,
  sourcePage?: string,
): StructuredDownload[] {
  return parseSectionDownloads(content, VERIFIED_HEADER, VERIFIED_LINE, sourcePage);
}

/** Pull gated/interaction-required downloads from a single source's content. */
export function parseInteractionRequiredDownloads(
  content: string,
  sourcePage?: string,
): StructuredDownload[] {
  return parseSectionDownloads(content, INTERACTION_HEADER, INTERACTION_LINE, sourcePage);
}

export function collectStructuredDownloads(
  sources: Chunk[],
  parser: (content: string, sourcePage?: string) => StructuredDownload[],
): StructuredDownload[] {
  const seen = new Set<string>();
  const merged: StructuredDownload[] = [];
  for (const src of sources) {
    const page =
      (src.metadata && (src.metadata.url as string)) || undefined;
    for (const d of parser(src.content, page)) {
      const key = d.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(d);
    }
  }
  return merged;
}
