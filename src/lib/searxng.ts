import { getSearxngURL } from './config/serverRegistry';

export interface SearxngSearchOptions {
  categories?: string[];
  engines?: string[];
  language?: string;
  pageno?: number;
}

interface SearxngSearchResult {
  title: string;
  url: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  content?: string;
  author?: string;
  iframe_src?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

export const SEARXNG_TIMEOUT_MS = Number(
  process.env.SEARXNG_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTimeoutError = (err: unknown) =>
  err instanceof Error &&
  (err.name === 'AbortError' || err.message === 'SearXNG search timed out');

export const searchSearxng = async (
  query: string,
  opts?: SearxngSearchOptions,
) => {
  const searxngURL = getSearxngURL();

  const url = new URL(`${searxngURL}/search?format=json`);
  url.searchParams.append('q', query);

  if (opts) {
    Object.keys(opts).forEach((key) => {
      const value = opts[key as keyof SearxngSearchOptions];
      if (Array.isArray(value)) {
        url.searchParams.append(key, value.join(','));
        return;
      }
      url.searchParams.append(key, value as string);
    });
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      SEARXNG_TIMEOUT_MS,
    );

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'X-Forwarded-For': '127.0.0.1',
          'X-Real-IP': '127.0.0.1',
        },
      });

      if (!res.ok) {
        throw new Error(`SearXNG error: ${res.statusText}`);
      }

      const data = await res.json();

      const results: SearxngSearchResult[] = data.results;
      const suggestions: string[] = data.suggestions;

      return { results, suggestions };
    } catch (err: unknown) {
      lastError = err;

      if (isTimeoutError(err) && attempt < MAX_RETRIES) {
        console.warn(
          `SearXNG search timed out (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying…`,
        );
        await sleep(1000 * (attempt + 1));
        continue;
      }

      if (isTimeoutError(err)) {
        throw new Error('SearXNG search timed out');
      }

      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (isTimeoutError(lastError)) {
    throw new Error('SearXNG search timed out');
  }

  throw lastError;
};
