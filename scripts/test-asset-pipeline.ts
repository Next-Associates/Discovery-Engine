/**
 * Standalone asset-pipeline verification report.
 * Run: npx tsx scripts/test-asset-pipeline.ts
 */

import {
  extractLinksFromHtml,
  isMalformedEmbeddedUrl,
  unwrapEmbeddedAbsoluteUrl,
} from '../src/lib/utils/extractLinks';
import { isAssetLikeUrl } from '../src/lib/utils/assetPipeline';
import {
  expandDownloadVerificationCandidates,
  verifyDownloadUrl,
  verifyDownloadUrls,
  warmPageSession,
} from '../src/lib/utils/verifyUrls';

type TestResult = {
  name: string;
  group: string;
  pass: boolean;
  detail: string;
};

const results: TestResult[] = [];

function record(
  group: string,
  name: string,
  pass: boolean,
  detail: string,
) {
  results.push({ group, name, pass, detail });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`  [${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function testUnitHelpers() {
  console.log('\n=== Unit: URL normalization ===');

  const malformed =
    'https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/10m/cultural/ne_10m_admin_0_countries.zip';
  const unwrapped = unwrapEmbeddedAbsoluteUrl(malformed);

  record(
    'unit',
    'unwrapEmbeddedAbsoluteUrl fixes CMS href',
    unwrapped ===
      'https://www.naturalearthdata.com/download/10m/cultural/ne_10m_admin_0_countries.zip',
    unwrapped,
  );

  record(
    'unit',
    'isMalformedEmbeddedUrl detects broken href',
    isMalformedEmbeddedUrl(malformed),
    String(isMalformedEmbeddedUrl(malformed)),
  );

  record(
    'unit',
    'isMalformedEmbeddedUrl false for normal URL',
    !isMalformedEmbeddedUrl('https://example.com/file.zip'),
    '',
  );

  const withContext = expandDownloadVerificationCandidates(
    unwrapped,
    malformed,
    true,
  );
  record(
    'unit',
    'expand candidates includes raw href with page context',
    withContext.includes(malformed),
    withContext.join(' | '),
  );

  const withoutContext = expandDownloadVerificationCandidates(
    unwrapped,
    malformed,
    false,
  );
  record(
    'unit',
    'expand candidates excludes raw href without page context',
    !withoutContext.includes(malformed),
    withoutContext.join(' | '),
  );

  record(
    'unit',
    'isAssetLikeUrl matches zip paths',
    isAssetLikeUrl('https://example.org/data/release/file.zip'),
    '',
  );

  record(
    'unit',
    'isAssetLikeUrl false for catalog pages',
    !isAssetLikeUrl('https://example.org/downloads/10m-admin-0-countries/'),
    '',
  );
}

async function testNaturalEarthPageContext() {
  console.log('\n=== Integration: Natural Earth (page-context redirect) ===');

  const catalog =
    'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-countries/';

  try {
    const html = await fetchHtml(catalog);
    const links = extractLinksFromHtml(html, catalog);
    const download = links.find((l) =>
      l.label.toLowerCase().includes('download countries'),
    );

    record(
      'natural-earth',
      'extract download link from catalog HTML',
      Boolean(download?.url && download.sourceHref),
      download
        ? `url=${download.url.slice(0, 60)}… sourceHref=${Boolean(download.sourceHref)}`
        : 'not found',
    );

    if (!download) return;

    const cookies = await warmPageSession(catalog);
    record(
      'natural-earth',
      'warmPageSession (optional — referer alone may suffice)',
      true,
      cookies ? `${cookies.split(';').length} cookie(s)` : 'no cookies; referer redirect still works',
    );

    const withoutContext = await verifyDownloadUrl({
      url: download.url,
      sourceHref: download.sourceHref,
    });
    record(
      'natural-earth',
      'without page context: should NOT verify (404/406)',
      !withoutContext.ok,
      withoutContext.ok
        ? `unexpected ok: ${withoutContext.verifiedUrl}`
        : 'correctly rejected',
    );

    const withContext = await verifyDownloadUrl(
      { url: download.url, sourceHref: download.sourceHref },
      { referer: catalog, cookieHeader: cookies },
    );
    const cdnOk =
      withContext.ok &&
      withContext.verifiedUrl?.includes('naciscdn.org/naturalearth/');
    record(
      'natural-earth',
      'with page context: redirects to naciscdn CDN',
      Boolean(cdnOk),
      withContext.verifiedUrl ?? 'failed',
    );

    record(
      'natural-earth',
      'verified URL is NOT the broken naturalearthdata.com/download path',
      Boolean(
        withContext.ok &&
          !withContext.verifiedUrl?.match(
            /^https:\/\/www\.naturalearthdata\.com\/download\//,
          ),
      ),
      withContext.verifiedUrl ?? '',
    );
  } catch (err) {
    record(
      'natural-earth',
      'Natural Earth integration block',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function testDirectKnownGoodUrl() {
  console.log('\n=== Integration: direct URL (no page context needed) ===');

  const directZip =
    'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip';

  try {
    const v = await verifyDownloadUrl(directZip);
    record(
      'direct',
      'CDN zip verifies without page context',
      v.ok === true,
      v.verifiedUrl ?? 'failed',
    );
  } catch (err) {
    record(
      'direct',
      'CDN zip verifies without page context',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function testRejectedBrokenUrls() {
  console.log('\n=== Integration: broken URLs rejected ===');

  const dead =
    'https://www.naturalearthdata.com/download/10m/cultural/ne_10m_admin_0_disputed_areas.zip';

  try {
    const v = await verifyDownloadUrl(dead);
    record(
      'reject',
      'dead naturalearthdata.com/download URL rejected',
      !v.ok,
      v.ok ? `unexpected: ${v.verifiedUrl}` : 'correctly rejected',
    );
  } catch (err) {
    record(
      'reject',
      'dead naturalearthdata.com/download URL rejected',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  const guessed = 'https://example.com/downloads/TotallyFakeDataset_2024.zip';
  try {
    const v = await verifyDownloadUrl(guessed);
    record(
      'reject',
      'non-existent guessed URL rejected',
      !v.ok,
      v.ok ? `unexpected: ${v.verifiedUrl}` : 'correctly rejected',
    );
  } catch (err) {
    record(
      'reject',
      'non-existent guessed URL rejected',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function testUnrelatedPublisher() {
  console.log('\n=== Integration: unrelated publisher (GitHub release asset) ===');

  // Well-known stable PDF — tests generic verification on unrelated domain
  const stablePdf =
    'https://www.un.org/Depts/los/convention_agreements/texts/unclos/unclos_e.pdf';

  try {
    const v = await verifyDownloadUrl(stablePdf);
    record(
      'other',
      'UN PDF verifies on unrelated domain',
      v.ok === true,
      v.verifiedUrl ?? `status failed`,
    );
  } catch (err) {
    record(
      'other',
      'GitHub release asset verifies',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function testBatchVerify() {
  console.log('\n=== Integration: batch verifyDownloadUrls ===');

  const catalog =
    'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-countries/';

  try {
    const html = await fetchHtml(catalog);
    const links = extractLinksFromHtml(html, catalog)
      .filter((l) => isAssetLikeUrl(l.url))
      .slice(0, 3);

    const verifications = await verifyDownloadUrls(
      links.map((l) => ({ url: l.url, sourceHref: l.sourceHref })),
      3,
      { referer: catalog },
    );

    const anyOk = verifications.some((v) => v.ok);

    record(
      'batch',
      'batch verify returns at least one OK for Natural Earth page',
      anyOk,
      `${verifications.filter((v) => v.ok).length}/${verifications.length} ok`,
    );

    record(
      'batch',
      'verified entries are file URLs (not HTML catalog pages)',
      verifications
        .filter((v) => v.ok)
        .every(
          (v) =>
            v.verifiedUrl &&
            !v.verifiedUrl.endsWith('/downloads/') &&
            !v.verifiedUrl.endsWith('/downloads'),
        ),
      verifications
        .filter((v) => v.ok)
        .map((v) => v.verifiedUrl)
        .join(', '),
    );
  } catch (err) {
    record(
      'batch',
      'batch verifyDownloadUrls',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function printReport() {
  const groups = [...new Set(results.map((r) => r.group))];
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  console.log('\n' + '='.repeat(60));
  console.log('ASSET PIPELINE TEST REPORT');
  console.log('='.repeat(60));

  for (const group of groups) {
    const g = results.filter((r) => r.group === group);
    const gPass = g.filter((r) => r.pass).length;
    console.log(`\n${group}: ${gPass}/${g.length} passed`);
    for (const r of g.filter((x) => !x.pass)) {
      console.log(`  ✗ ${r.name}: ${r.detail}`);
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`TOTAL: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('-'.repeat(60));

  if (failed > 0) process.exit(1);
}

async function main() {
  console.log('Asset pipeline test suite');
  console.log(`Date: ${new Date().toISOString()}`);

  await testUnitHelpers();
  await testNaturalEarthPageContext();
  await testDirectKnownGoodUrl();
  await testRejectedBrokenUrls();
  await testUnrelatedPublisher();
  await testBatchVerify();

  printReport();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
