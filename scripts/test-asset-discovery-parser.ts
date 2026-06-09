/**
 * Round-trip test for the Phase 2b /api/asset-discovery parser.
 *
 * Proves parseVerifiedDownloads() reads back exactly what the existing
 * formatVerifiedLinksSection() (used by scrapeURL.ts) writes — so the structured
 * `verified_downloads` array is faithful to the prose the agent already emits.
 *
 * Run: npx tsx scripts/test-asset-discovery-parser.ts
 */
import {
  formatVerifiedLinksSection,
  formatInteractionRequiredLinksSection,
  formatSourcePagesSection,
  type VerifiedDownload,
} from '../src/lib/utils/extractLinks';
import {
  parseVerifiedDownloads,
  parseInteractionRequiredDownloads,
} from '../src/app/api/asset-discovery/route';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// 1) Round-trip: producer -> parser yields the same links/status.
const verified: VerifiedDownload[] = [
  { label: 'World EEZ v12 (shapefile)', url: 'https://www.marineregions.org/files/eez_v12.zip', status: 200 },
  { label: 'World EEZ v12 (geopackage)', url: 'https://www.marineregions.org/files/eez_v12.gpkg', status: 206 },
];
const content =
  'Some extracted facts about EEZ boundaries.\n\n' +
  formatVerifiedLinksSection(verified) +
  '\n\n' +
  formatSourcePagesSection([{ url: 'https://www.marineregions.org/downloads.php', title: 'Downloads' }]);

const parsed = parseVerifiedDownloads(content, 'https://www.marineregions.org/downloads.php');
check('parses both verified downloads', parsed.length === 2);
check('url 1 exact', parsed[0]?.url === 'https://www.marineregions.org/files/eez_v12.zip');
check('label 1 exact', parsed[0]?.label === 'World EEZ v12 (shapefile)');
check('status 1 == 200', parsed[0]?.status === 200);
check('status 2 == 206 (non-200 preserved)', parsed[1]?.status === 206);
check('sourcePage propagated', parsed[0]?.sourcePage === 'https://www.marineregions.org/downloads.php');

// 2) Stops at the next section (does not swallow Source pages URLs).
check(
  'does not capture catalog/source page as a download',
  !parsed.some((d) => d.url.endsWith('/downloads.php')),
);

// 3) No verified section -> empty.
check(
  'no verified section yields []',
  parseVerifiedDownloads('Just some facts, no links here.').length === 0,
);

// 4) Unverified note must not be parsed as a verified download.
check(
  'unverified note yields []',
  parseVerifiedDownloads(
    '## Direct downloads not verified\nAsset-like links were found but none returned HTTP 200.',
  ).length === 0,
);

// 5) Interaction-required round-trip.
const gated: VerifiedDownload[] = [
  {
    label: 'World EEZ v12 (shapefile)',
    url: 'https://www.marineregions.org/download_file.php?name=World_EEZ_v12_20231025.zip',
    status: 200,
  },
];
const gatedContent =
  'Facts.\n\n' +
  formatInteractionRequiredLinksSection(gated);
const gatedParsed = parseInteractionRequiredDownloads(
  gatedContent,
  'https://www.marineregions.org/downloads.php',
);
check('parses interaction-required download', gatedParsed.length === 1);
check(
  'interaction url exact',
  gatedParsed[0]?.url ===
    'https://www.marineregions.org/download_file.php?name=World_EEZ_v12_20231025.zip',
);
check('interaction status == 200', gatedParsed[0]?.status === 200);
check(
  'interaction sourcePage propagated',
  gatedParsed[0]?.sourcePage === 'https://www.marineregions.org/downloads.php',
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
