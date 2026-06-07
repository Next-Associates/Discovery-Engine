import {
  isMalformedEmbeddedUrl,
  unwrapEmbeddedAbsoluteUrl,
} from './extractLinks';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const VERIFY_TIMEOUT_MS = 12_000;

export type UrlVerification = {
  url: string;
  ok: boolean;
  status?: number;
  verifiedUrl?: string;
};

export type VerifyPageContext = {
  /** Catalog/page URL the download link was found on — sent as Referer. */
  referer: string;
  cookieHeader?: string;
};

export type DownloadLinkInput = {
  url: string;
  sourceHref?: string;
};

/**
 * Visit a catalog page to obtain session cookies for gated download redirects.
 * Works for any site that requires same-origin context before redirecting to CDN.
 */
export async function warmPageSession(pageUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(pageUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!res.ok) return undefined;

    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [];

    if (setCookies.length === 0) return undefined;

    return setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
  } catch {
    return undefined;
  }
}

/**
 * Build probe candidates for a scraped download link.
 * With page context, include the raw CMS href (often the redirect route).
 */
export function expandDownloadVerificationCandidates(
  url: string,
  sourceHref?: string,
  withPageContext = false,
): string[] {
  const trimmed = url.trim();
  if (!trimmed) return [];

  const candidates: string[] = [];
  const raw = sourceHref?.trim();

  if (withPageContext && raw && isMalformedEmbeddedUrl(raw)) {
    candidates.push(raw);
  }

  const unwrapped = unwrapEmbeddedAbsoluteUrl(trimmed);
  candidates.push(unwrapped);

  if (trimmed !== unwrapped) {
    candidates.push(trimmed);
  }

  if (withPageContext && raw && raw !== unwrapped && !candidates.includes(raw)) {
    candidates.push(raw);
  }

  return [...new Set(candidates.filter(Boolean))];
}

/** Reject HTML catalog pages that return 200 but are not file downloads. */
function responseLooksLikeFile(res: Response, candidate: string): boolean {
  if (!res.ok) return false;

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) return false;

  if (FILE_EXTENSION.test(candidate)) return true;

  const binaryTypes = [
    'application/octet-stream',
    'application/zip',
    'application/pdf',
    'application/gzip',
    'application/x-gzip',
    'application/vnd.',
    'image/',
    'audio/',
    'video/',
  ];

  return binaryTypes.some((t) => contentType.includes(t));
}

const FILE_EXTENSION =
  /\.(zip|gpkg|shp|geojson|json|xml|csv|xlsx|pdf|kmz|tar|gz|7z|docx?|tiff?|tif)(\?|#|$)/i;

async function probeDownloadUrl(
  candidate: string,
  context?: VerifyPageContext,
): Promise<UrlVerification & { candidate: string }> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
  };

  if (context?.referer) {
    headers.Referer = context.referer;
    headers.Accept = '*/*';
  }

  if (context?.cookieHeader) {
    headers.Cookie = context.cookieHeader;
  }

  try {
    let res = await fetch(candidate, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      headers,
    });

    if (
      !res.ok &&
      (res.status === 405 ||
        res.status === 403 ||
        res.status === 406 ||
        res.status === 501)
    ) {
      res = await fetch(candidate, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        headers: {
          ...headers,
          Range: 'bytes=0-0',
        },
      });
    }

    return {
      url: candidate,
      candidate,
      ok: responseLooksLikeFile(res, candidate),
      status: res.status,
      verifiedUrl: res.url || candidate,
    };
  } catch {
    return { url: candidate, candidate, ok: false };
  }
}

export async function verifyDownloadUrl(
  input: string | DownloadLinkInput,
  pageContext?: VerifyPageContext,
): Promise<UrlVerification> {
  const link =
    typeof input === 'string'
      ? { url: input, sourceHref: undefined }
      : input;

  const candidates = expandDownloadVerificationCandidates(
    link.url,
    link.sourceHref,
    Boolean(pageContext),
  );

  for (const candidate of candidates) {
    const result = await probeDownloadUrl(candidate, pageContext);
    if (result.ok) {
      return {
        url: link.url,
        ok: true,
        status: result.status,
        verifiedUrl: result.verifiedUrl ?? candidate,
      };
    }
  }

  return { url: link.url, ok: false };
}

export async function verifyDownloadUrls(
  inputs: Array<string | DownloadLinkInput>,
  limit = 12,
  pageContext?: VerifyPageContext,
): Promise<UrlVerification[]> {
  const unique: DownloadLinkInput[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const link =
      typeof input === 'string'
        ? { url: input.trim(), sourceHref: undefined }
        : { url: input.url.trim(), sourceHref: input.sourceHref?.trim() };

    if (!link.url || seen.has(link.url.toLowerCase())) continue;
    seen.add(link.url.toLowerCase());
    unique.push(link);
    if (unique.length >= limit) break;
  }

  let context = pageContext;
  if (context?.referer && !context.cookieHeader) {
    const cookieHeader = await warmPageSession(context.referer);
    if (cookieHeader) {
      context = { ...context, cookieHeader };
    }
  }

  return Promise.all(unique.map((link) => verifyDownloadUrl(link, context)));
}

/** Suspected guessed direct-file paths (any domain) — used to warn, not block. */
export const STALE_URL_PATTERNS = [
  /\/downloads\/[^/?#]+\.(zip|gpkg|shp|tar|gz)$/i,
  /\/downloads\.html$/i,
];

export function isLikelyStaleDownloadUrl(url: string): boolean {
  return STALE_URL_PATTERNS.some((p) => p.test(url));
}
