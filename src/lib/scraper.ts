import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Mutex } from 'async-mutex';
import {
  extractAssetUrlsFromHtmlSource,
  extractLinksFromHtml,
  formatLinksSection,
  mergeLinks,
  type ExtractedLink,
} from '@/lib/utils/extractLinks';
import { resolvePortalLinks } from '@/lib/utils/portalLinks';

export type ScrapeResult = {
  content: string;
  title: string;
  links: string;
  extractedLinks?: ExtractedLink[];
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

class Scraper {
  private static browser: any | undefined;
  private static playwrightUnavailable = false;
  private static IDLE_KILL_TIMEOUT = 30000;
  private static NAVIGATION_TIMEOUT = 20000;
  private static idleTimeout: NodeJS.Timeout | undefined;
  private static browserMutex = new Mutex();
  private static userCount = 0;

  private static async buildPageLinks(
    url: string,
    html: string,
    pageUrl: string,
  ): Promise<ExtractedLink[]> {
    const htmlLinks = extractLinksFromHtml(html, pageUrl);
    const sourceAssetLinks = extractAssetUrlsFromHtmlSource(html, pageUrl);
    const portalLinks = await resolvePortalLinks(url);
    return mergeLinks(htmlLinks, sourceAssetLinks, portalLinks);
  }

  private static async parseHtml(
    url: string,
    html: string,
    pageUrl: string,
  ): Promise<ScrapeResult> {
    const dom = new JSDOM(html, { url: pageUrl });
    const content = new Readability(dom.window.document).parse();
    const title = dom.window.document.title || 'No title';
    const extractedLinks = await this.buildPageLinks(url, html, pageUrl);
    const links = formatLinksSection(extractedLinks);

    return {
      content: `
        # ${title} - ${url}
        ${content?.textContent?.trim() ?? 'No content available'}
        `,
      links,
      title,
      extractedLinks,
    };
  }

  private static async scrapeWithFetch(url: string): Promise<ScrapeResult> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(this.NAVIGATION_TIMEOUT),
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const pageUrl = response.url || url;

    return await this.parseHtml(url, html, pageUrl);
  }

  /** ArcGIS and other JS portals may have no HTML links — resolve via APIs. */
  private static async scrapePortalOnly(url: string): Promise<ScrapeResult | null> {
    const portalLinks = await resolvePortalLinks(url);
    if (portalLinks.length === 0) return null;

    const links = formatLinksSection(portalLinks);
    return {
      title: portalLinks[0]?.label ?? 'Portal item',
      content: `# ${url}\n\nPortal metadata resolved via API (page is JavaScript-rendered).`,
      links,
      extractedLinks: portalLinks,
    };
  }

  private static async initBrowser() {
    if (this.playwrightUnavailable) return;

    await this.browserMutex.runExclusive(async () => {
      if (this.browser || this.playwrightUnavailable) return;

      try {
        const { chromium } = await import('playwright');
        this.browser = await chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
          ],
        });
      } catch (err) {
        this.playwrightUnavailable = true;
        console.log(
          'Playwright browser unavailable (run: npx playwright install chromium). Using HTTP fetch fallback.',
          err instanceof Error ? err.message : err,
        );
      }

      if (this.idleTimeout) clearTimeout(this.idleTimeout);
    });
  }

  private static scheduleIdleKill() {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);

    this.idleTimeout = setTimeout(async () => {
      await this.browserMutex.runExclusive(async () => {
        if (this.browser && this.userCount === 0) {
          await this.browser.close();
          this.browser = undefined;
        }
      });
    }, this.IDLE_KILL_TIMEOUT);
  }

  private static async scrapeWithPlaywright(url: string): Promise<ScrapeResult> {
    await this.initBrowser();

    if (!this.browser) {
      throw new Error('Playwright browser not available');
    }

    const context = await this.browser.newContext({ userAgent: USER_AGENT });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    this.userCount++;

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.NAVIGATION_TIMEOUT,
      });

      await page
        .waitForLoadState('load', { timeout: 5000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);

      const html = await page.content();
      const pageUrl = page.url();
      const result = await this.parseHtml(url, html, pageUrl);
      result.title = (await page.title()) || result.title;

      return result;
    } finally {
      this.userCount--;
      await context.close().catch(() => undefined);

      if (this.userCount === 0) {
        this.scheduleIdleKill();
      }
    }
  }

  static async scrape(url: string): Promise<ScrapeResult> {
    try {
      return await this.scrapeWithPlaywright(url);
    } catch (playwrightErr) {
      console.log(
        `Playwright scrape failed for ${url}, trying HTTP fetch:`,
        playwrightErr instanceof Error ? playwrightErr.message : playwrightErr,
      );
    }

    try {
      const fetched = await this.scrapeWithFetch(url);
      if (
        (!fetched.extractedLinks || fetched.extractedLinks.length === 0) &&
        /arcgis\.com\/home\/item\.html/i.test(url)
      ) {
        const portal = await this.scrapePortalOnly(url);
        if (portal) return portal;
      }
      return fetched;
    } catch (fetchErr) {
      const portal = await this.scrapePortalOnly(url);
      if (portal) return portal;

      console.log(`Error scraping ${url}:`, fetchErr);

      return {
        title: 'Failed to scrape',
        content: `# ${url}\n\nError scraping content.`,
        links: '',
      };
    }
  }
}

export default Scraper;
