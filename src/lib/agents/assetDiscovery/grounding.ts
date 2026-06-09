/**
 * Phase 2c — grounding guard (spec §4.2).
 *
 * Every asset URL the LLM emits MUST appear verbatim (after normalization) in some
 * scraped source's content. Otherwise it is dropped and logged to warnings[]. This
 * is the anti-hallucination backstop: the LLM may SELECT and GROUP URLs, never invent
 * or mutate them. Verified on real data: keeps the 24 real download_file.php URLs,
 * kills invented ones.
 */

/** Decode the HTML entities that survive into scraped text + strip fragments. */
export function normalizeUrlForMatch(url: string): string {
  if (!url) return '';
  let u = url.trim();
  // Strip surrounding markdown/quote noise.
  u = u.replace(/^[<("']+/, '').replace(/[>)"'.,;]+$/, '');
  // Decode the common entities readability/jsdom leave in text.
  u = u
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
  // Drop fragment.
  const hash = u.indexOf('#');
  if (hash !== -1) u = u.slice(0, hash);
  return u;
}

/**
 * Build a single normalized haystack from all source contents (+ their candidate
 * URLs). Entities decoded so `&amp;` in scraped text matches `&` in a clean URL.
 */
export function buildGroundingHaystack(
  sources: Array<{ content: string; candidate_assets?: Array<{ url: string }> }>,
): string {
  const parts: string[] = [];
  for (const s of sources) {
    if (s.content) parts.push(s.content);
    for (const a of s.candidate_assets ?? []) {
      if (a.url) parts.push(a.url);
    }
  }
  return parts
    .join('\n')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&');
}

/** True when the URL (normalized) appears verbatim somewhere in the haystack. */
export function isGrounded(url: string, haystack: string): boolean {
  const n = normalizeUrlForMatch(url);
  if (!n) return false;
  if (haystack.includes(n)) return true;
  // Also try the raw form (in case normalization stripped a meaningful trailing char).
  return haystack.includes(url.trim());
}
