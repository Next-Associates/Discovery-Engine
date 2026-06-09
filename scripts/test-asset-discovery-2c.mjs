/**
 * Phase 2c — Unified Asset Discovery, milestone e2e tests.
 *
 * Hits a RUNNING Vane server (default http://localhost:3000) and asserts the
 * milestone acceptance criteria. Add a check per milestone as the pipeline grows.
 *
 * Run:  node scripts/test-asset-discovery-2c.mjs
 *   env BASE_URL=http://host:3000   target server
 *       MILESTONE=1                  run only milestone N's checks (default: all defined)
 */

// The 2c route does all work before returning headers (no streaming), so long runs
// can exceed undici's default 300s headers timeout. Disable it for the harness
// (the product's Python client uses its own timeout). Requires Node 20.
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));
} catch (e) {
  console.warn('(could not raise undici timeout — run under Node 20):', e?.message);
}

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const ENDPOINT = `${BASE_URL}/api/asset-discovery`;
const ONLY = process.env.MILESTONE ? Number(process.env.MILESTONE) : null;

let passed = 0;
let failed = 0;
const results = [];

function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  ok ? passed++ : failed++;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function post(body, timeoutMs = 300_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, elapsed };
  } finally {
    clearTimeout(t);
  }
}

const EXPECTED_TOP_KEYS = [
  'query',
  'generated_at',
  'requirements',
  'stats',
  'raw_sources',
  'datasets',
  'data_pages',
  'dropped',
  'warnings',
];

// ── Milestone 1: endpoint skeleton + catalog-scrape reliability ──────────────
async function milestone1() {
  console.log('\n── Milestone 1: endpoint skeleton + catalog-scrape reliability ──');

  // 1a. Validation: empty body must 400.
  const bad = await post({});
  check('empty body rejected (400)', bad.status === 400, `got ${bad.status}`);

  // 1b. Structured EEZ run.
  const body = {
    requirements: [
      { id: 'r1', text: 'World EEZ boundaries shapefile latest version from marineregions.org' },
    ],
    urls: ['https://www.marineregions.org/downloads.php'],
    maxSources: 5,
  };
  const { status, json, elapsed } = await post(body);
  console.log(`     (run took ${elapsed}s)`);

  check('HTTP 200', status === 200, `got ${status}`);
  check(
    'all top-level keys present',
    EXPECTED_TOP_KEYS.every((k) => k in json),
    `missing: ${EXPECTED_TOP_KEYS.filter((k) => !(k in json)).join(', ') || 'none'}`,
  );
  check('no prose `message` leaked', !('message' in json));
  check(
    'catalog page(s) actually fetched',
    Array.isArray(json.stats?.catalog_pages_fetched) &&
      json.stats.catalog_pages_fetched.length >= 1,
    `fetched: ${JSON.stringify(json.stats?.catalog_pages_fetched)}`,
  );
  check(
    'raw candidate assets found',
    (json.stats?.candidates_found ?? 0) > 0,
    `candidates_found=${json.stats?.candidates_found}`,
  );
  check(
    'sources_scraped within maxSources',
    (json.stats?.sources_scraped ?? 99) <= 5,
    `sources_scraped=${json.stats?.sources_scraped}`,
  );

  const allCandidateUrls = (json.raw_sources ?? []).flatMap((s) =>
    (s.candidate_assets ?? []).map((a) => a.url),
  );
  const dlFile = allCandidateUrls.filter((u) => /download_file\.php/i.test(u));
  check(
    'real download_file.php URLs captured verbatim',
    dlFile.length > 0,
    `${dlFile.length} download_file.php URLs`,
  );

  const catalogSource = (json.raw_sources ?? []).find((s) => s.is_catalog && !s.error);
  check(
    'at least one source classified asset_host',
    (json.raw_sources ?? []).some((s) => s.classification === 'asset_host'),
  );
  check(
    'content suppressed when include_sources=false',
    (json.raw_sources ?? []).every((s) => s.content === ''),
  );
  check('no sources[] echoed when include_sources=false', !('sources' in json));

  // 1c. include_sources=true echoes ground-truth content.
  const withSources = await post({ ...body, include_sources: true });
  check(
    'include_sources=true echoes sources[] with content',
    Array.isArray(withSources.json.sources) &&
      withSources.json.sources.length > 0 &&
      withSources.json.sources.some((s) => (s.content ?? '').length > 0),
  );
}

// ── Milestone 2: LLM structured extraction + grounding guard ─────────────────
function normForMatch(u) {
  return String(u)
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/#.*$/, '');
}

async function milestone2() {
  console.log('\n── Milestone 2: LLM structured extraction + grounding guard ──');

  const body = {
    requirements: [
      { id: 'r1', text: 'World EEZ boundaries shapefile latest version from marineregions.org' },
    ],
    urls: ['https://www.marineregions.org/downloads.php'],
    maxSources: 6,
    include_sources: true, // needed to verify grounding against ground truth
  };
  const { status, json, elapsed } = await post(body, 480_000);
  console.log(`     (run took ${elapsed}s)`);

  check('HTTP 200', status === 200, `got ${status}`);

  const datasets = json.datasets ?? [];
  check('datasets[] non-empty', datasets.length > 0, `${datasets.length} datasets`);

  const allAssets = datasets.flatMap((d) => d.assets ?? []);
  check('datasets carry assets', allAssets.length > 0, `${allAssets.length} assets`);

  check(
    'every asset has found_in_source=true',
    allAssets.length > 0 && allAssets.every((a) => a.found_in_source === true),
  );
  check(
    'every asset has a non-empty url + format',
    allAssets.every((a) => a.url && a.format),
  );

  const dlFile = allAssets.filter((a) => /download_file\.php/i.test(a.url));
  check(
    'real download_file.php asset URLs present in datasets',
    dlFile.length > 0,
    `${dlFile.length} download_file.php assets`,
  );

  // REAL grounding check: every emitted asset URL must appear verbatim in sources.
  const haystack = (json.sources ?? [])
    .map((s) => s.content ?? '')
    .join('\n')
    .replace(/&amp;/gi, '&');
  const ungrounded = allAssets
    .map((a) => a.url)
    .filter((u) => !haystack.includes(normForMatch(u)) && !haystack.includes(u));
  check(
    'ALL emitted asset URLs are grounded in source content',
    ungrounded.length === 0,
    ungrounded.length ? `ungrounded: ${ungrounded.slice(0, 3).join(', ')}` : 'all grounded',
  );

  // EEZ family should be among the structured datasets (the gold case).
  check(
    'EEZ dataset family detected',
    datasets.some((d) => /eez/i.test(d.dataset_family) || /eez/i.test(d.dataset_name)),
    `families: ${datasets.map((d) => d.dataset_family).slice(0, 8).join(' | ')}`,
  );

  // Family grouping: at least one family should appear (distinct families allowed).
  const families = new Set(datasets.map((d) => d.dataset_family));
  check('dataset_family grouping present', families.size >= 1, `${families.size} families`);

  if (datasets.length) {
    const sample = datasets.find((d) => /eez/i.test(d.dataset_family)) ?? datasets[0];
    console.log(
      `     sample: family="${sample.dataset_family}" name="${sample.dataset_name}" v=${sample.version} assets=${(sample.assets || []).length}`,
    );
  }
}

// ── Milestone 3: HTTP probe + verification_status ───────────────────────────
async function milestone3() {
  console.log('\n── Milestone 3: HTTP probe + verification_status ──');

  const body = {
    requirements: [
      { id: 'r1', text: 'World EEZ boundaries shapefile latest version from marineregions.org' },
    ],
    urls: ['https://www.marineregions.org/downloads.php'],
    maxSources: 6,
  };
  const { status, json, elapsed } = await post(body, 480_000);
  console.log(`     (run took ${elapsed}s)`);

  check('HTTP 200', status === 200, `got ${status}`);

  const allAssets = (json.datasets ?? []).flatMap((d) => d.assets ?? []);
  check('assets present', allAssets.length > 0, `${allAssets.length} assets`);

  const VALID = new Set(['verified_200', 'requires_interaction', 'unverified']);
  check(
    'every asset has a valid verification_status',
    allAssets.every((a) => VALID.has(a.verification_status)),
    `statuses: ${[...new Set(allAssets.map((a) => a.verification_status))].join(', ')}`,
  );
  check(
    'every asset has http_status field (number or null)',
    allAssets.every((a) => 'http_status' in a),
  );

  const gated = allAssets.filter((a) => /download_file\.php/i.test(a.url));
  check(
    'download_file.php assets classified requires_interaction',
    gated.length > 0 && gated.every((a) => a.verification_status === 'requires_interaction'),
    `${gated.filter((a) => a.verification_status === 'requires_interaction').length}/${gated.length} gated`,
  );
  check(
    'gated assets record real http_status (not null)',
    gated.every((a) => a.http_status === 200 || typeof a.http_status === 'number'),
    `sample http_status=${gated[0]?.http_status}`,
  );

  // Status must NEVER filter: assets survive regardless of verification_status.
  check(
    'verification did not drop any asset (status annotates only)',
    !(json.dropped ?? []).some((d) => /verif|http|200|gate/i.test(d.reason || '')),
  );

  const tally = json.stats?.verification;
  check(
    'stats.verification tally present',
    tally && typeof tally.interaction === 'number',
    `verified=${tally?.verified} interaction=${tally?.interaction} unverified=${tally?.unverified}`,
  );
}

// ── Milestone 4: interaction detection (D7) + multi-format (D8) ─────────────
async function milestone4() {
  console.log('\n── Milestone 4: interaction detection (D7) + multi-format (D8) ──');

  const body = {
    requirements: [
      { id: 'r1', text: 'World EEZ boundaries shapefile latest version from marineregions.org' },
    ],
    urls: ['https://www.marineregions.org/downloads.php'],
    maxSources: 6,
  };
  const { status, json, elapsed } = await post(body, 480_000);
  console.log(`     (run took ${elapsed}s)`);

  check('HTTP 200', status === 200, `got ${status}`);

  const datasets = json.datasets ?? [];
  const gated = datasets
    .flatMap((d) => d.assets ?? [])
    .filter((a) => a.verification_status === 'requires_interaction');
  check('gated assets present', gated.length > 0, `${gated.length} gated`);

  check(
    'every gated asset carries interaction{} spec',
    gated.every((a) => a.interaction && typeof a.interaction === 'object'),
  );
  check(
    'interaction.type=form_post, method=post',
    gated.every((a) => a.interaction?.type === 'form_post' && a.interaction?.method === 'post'),
    `sample type=${gated[0]?.interaction?.type} method=${gated[0]?.interaction?.method}`,
  );
  check(
    'interaction.action equals the asset URL',
    gated.every((a) => a.interaction?.action === a.url),
  );

  const sample = gated[0]?.interaction;
  const kinds = new Set((sample?.fields ?? []).map((f) => f.kind));
  check('detected identity_email field', kinds.has('identity_email'), `kinds: ${[...kinds].join(', ')}`);
  check('detected identity_name field', kinds.has('identity_name'));
  check('detected identity_org field', kinds.has('identity_org'));
  check(
    'detected agreement_checkbox with value',
    (sample?.fields ?? []).some((f) => f.kind === 'agreement_checkbox' && f.value),
  );
  check(
    'honeypot field(s) detected (must stay empty)',
    Array.isArray(sample?.honeypot_fields) && sample.honeypot_fields.length > 0,
    `honeypot: ${JSON.stringify(sample?.honeypot_fields)}`,
  );
  check(
    'honeypot is the firstname-* off-screen field',
    (sample?.honeypot_fields ?? []).some((n) => /firstname/i.test(n)),
  );

  // D8 multi-format: EEZ v12 should expose multiple formats as distinct assets.
  const v12 = datasets.find((d) => /v12/i.test(d.version || d.dataset_name || ''));
  const v12formats = new Set((v12?.assets ?? []).map((a) => (a.format || '').toLowerCase()));
  check(
    'multi-format assets present for EEZ v12 (D8)',
    v12formats.size >= 2,
    `formats: ${[...v12formats].join(', ')}`,
  );
}

// ── Milestone 5: dedup + requirement filter + version select (D4) ───────────
async function milestone5() {
  console.log('\n── Milestone 5: dedup + requirement filter + version select (D4) ──');

  const body = {
    requirements: [
      { id: 'r1', text: 'World EEZ (Exclusive Economic Zone) boundaries, latest version' },
    ],
    urls: ['https://www.marineregions.org/downloads.php'],
    maxSources: 6,
  };
  const { status, json, elapsed } = await post(body, 600_000);
  console.log(`     (run took ${elapsed}s)`);

  check('HTTP 200', status === 200, `got ${status}`);

  const datasets = json.datasets ?? [];
  const dropped = json.dropped ?? [];
  console.log(`     kept families: ${datasets.map((d) => `${d.dataset_family}(${d.version})`).join(' | ')}`);
  console.log(`     dropped: ${JSON.stringify(dropped.reduce((m, d) => { m[d.reason] = (m[d.reason]||0)+1; return m; }, {}))}`);

  check('datasets non-empty', datasets.length > 0, `${datasets.length}`);
  check('every kept dataset is_latest=true', datasets.every((d) => d.is_latest === true));

  const families = datasets.map((d) => d.dataset_family);
  check('families distinct (collapsed one per family)', new Set(families).size === families.length);

  const fvKeys = datasets.map((d) => `${d.dataset_family}|${d.version}`);
  check('no duplicate (family,version)', new Set(fvKeys).size === fvKeys.length);

  check(
    'all kept families are requirement-relevant (EEZ)',
    datasets.every((d) => /eez|exclusive economic/i.test(d.dataset_family)),
    `kept: ${families.join(', ')}`,
  );

  const eez = datasets.find((d) => /eez/i.test(d.dataset_family));
  check('EEZ family survived', !!eez);
  check('EEZ latest version is v12', /12/.test(eez?.version || eez?.dataset_name || ''), `version=${eez?.version}`);
  check(
    'EEZ has superseded_versions (older versions collapsed)',
    Array.isArray(eez?.superseded_versions) && eez.superseded_versions.length >= 1,
    `${eez?.superseded_versions?.length} superseded`,
  );
  check(
    'superseded_versions are metadata-only (no assets) by default',
    (eez?.superseded_versions ?? []).every((s) => !('assets' in s)),
  );

  check(
    'dropped[] has superseded entries (version collapse)',
    dropped.some((d) => d.reason === 'superseded'),
  );
  check(
    'requirement filter ran (kept datasets carry requirement_ids)',
    datasets.every((d) => Array.isArray(d.requirement_ids) && d.requirement_ids.length > 0),
    `sample ids: ${JSON.stringify(datasets[0]?.requirement_ids)}`,
  );
  // requirement_mismatch dropping is proven deterministically in test-postprocess-core.ts.
  console.log(
    `     (info) requirement_mismatch dropped: ${dropped.filter((d) => d.reason === 'requirement_mismatch').length} (focused structuring usually returns only relevant families)`,
  );

  // include_superseded_assets=true should attach assets to superseded entries.
  const withSup = await post({ ...body, include_superseded_assets: true }, 600_000);
  const eez2 = (withSup.json.datasets ?? []).find((d) => /eez/i.test(d.dataset_family));
  check(
    'include_superseded_assets=true attaches assets to superseded_versions',
    (eez2?.superseded_versions ?? []).some((s) => Array.isArray(s.assets) && s.assets.length > 0),
  );
}

// ── Milestone 6: requirement mapping (D9) ───────────────────────────────────
async function milestone6() {
  console.log('\n── Milestone 6: requirement mapping (D9) ──');

  const body = {
    requirements: [
      { id: 'r1', text: 'World EEZ boundaries shapefile, latest version' },
      { id: 'r2', text: 'territorial sea / 12 nautical mile limit dataset' },
    ],
    urls: ['https://www.marineregions.org/downloads.php'],
    maxSources: 6,
  };
  const { status, json, elapsed } = await post(body, 600_000);
  console.log(`     (run took ${elapsed}s)`);

  check('HTTP 200', status === 200, `got ${status}`);
  const datasets = json.datasets ?? [];
  check('datasets present', datasets.length > 0, `${datasets.length}`);

  check(
    'every dataset has non-empty requirement_ids[]',
    datasets.every((d) => Array.isArray(d.requirement_ids) && d.requirement_ids.length > 0),
    `sample: ${JSON.stringify(datasets[0]?.requirement_ids)}`,
  );
  const KNOWN = new Set(['r1', 'r2']);
  check(
    'requirement_ids reference provided requirement ids',
    datasets.every((d) => d.requirement_ids.every((id) => KNOWN.has(id))),
    `ids seen: ${[...new Set(datasets.flatMap((d) => d.requirement_ids))].join(', ')}`,
  );

  const allAssets = datasets.flatMap((d) => d.assets ?? []);
  check(
    'every asset carries requirement_ids[]',
    allAssets.length > 0 && allAssets.every((a) => Array.isArray(a.requirement_ids) && a.requirement_ids.length > 0),
  );
  check(
    "asset requirement_ids match their dataset's",
    datasets.every((d) => (d.assets ?? []).every((a) => JSON.stringify(a.requirement_ids) === JSON.stringify(d.requirement_ids))),
  );
}

// ── Milestone 7: data-page extraction (§5) ──────────────────────────────────
async function milestone7() {
  console.log('\n── Milestone 7: data-page extraction (§5) ──');

  // Isolate the data-page path: methodology pages carry data inline but few/no asset
  // links, so structuring is skipped and only §5 data-page extraction runs (fast).
  const body = {
    requirements: [
      { id: 'r1', text: 'methodology used to define World EEZ maritime boundaries' },
    ],
    urls: [
      'https://www.marineregions.org/eezmethodology.php',
      'https://www.marineregions.org/eez.php',
    ],
    maxSources: 3,
  };
  const { status, json, elapsed } = await post(body, 600_000);
  console.log(`     (run took ${elapsed}s)`);

  check('HTTP 200', status === 200, `got ${status}`);

  const dataPages = json.data_pages ?? [];
  console.log(`     data_pages: ${dataPages.map((d) => d.url).join(' | ') || 'none'}`);

  check('data_pages[] is an array', Array.isArray(dataPages));
  check('at least one data_page extracted', dataPages.length >= 1, `${dataPages.length}`);
  check(
    'each data_page has url + requirement_ids + extracted',
    dataPages.every((d) => d.url && Array.isArray(d.requirement_ids) && d.extracted),
  );
  check(
    'extracted carries summary or facts',
    dataPages.every((d) => (d.extracted.summary && d.extracted.summary.length > 0) || (Array.isArray(d.extracted.facts) && d.extracted.facts.length > 0)),
  );
  check(
    'data_pages requirement_ids reference provided ids',
    dataPages.every((d) => d.requirement_ids.every((id) => id === 'r1')),
  );

  // §5: a data_page is extracted, NOT emitted as a downloadable asset/file.
  const assetUrls = new Set((json.datasets ?? []).flatMap((d) => (d.assets ?? []).map((a) => a.url)));
  check(
    'data_page URLs are not emitted as downloadable assets',
    dataPages.every((d) => !assetUrls.has(d.url)),
  );

  if (dataPages[0]) {
    console.log(`     sample extracted: "${(dataPages[0].extracted.summary || '').slice(0, 120)}" (${dataPages[0].extracted.facts?.length || 0} facts)`);
  }
}

// ── Milestone 9: generalization gate (non-maritime publisher) ───────────────
async function milestone9() {
  console.log('\n── Milestone 9: generalization gate (GitHub releases, non-maritime) ──');

  const body = {
    requirements: [
      { id: 'r1', text: 'jq command-line JSON processor release binaries, latest version' },
    ],
    urls: ['https://github.com/jqlang/jq/releases'],
    maxSources: 4,
  };
  const { status, json, elapsed } = await post(body, 600_000);
  console.log(`     (run took ${elapsed}s)`);

  check('HTTP 200', status === 200, `got ${status}`);

  const datasets = json.datasets ?? [];
  console.log(`     families: ${datasets.map((d) => `${d.dataset_family}(${d.version})`).join(' | ') || 'none'}`);

  check('datasets non-empty for a non-maritime publisher', datasets.length > 0, `${datasets.length}`);
  check('every kept dataset is_latest=true', datasets.every((d) => d.is_latest === true));

  const families = datasets.map((d) => d.dataset_family);
  check('families distinct (collapsed per family)', new Set(families).size === families.length);

  const allAssets = datasets.flatMap((d) => d.assets ?? []);
  check('assets present', allAssets.length > 0, `${allAssets.length} assets`);
  check('every asset grounded (found_in_source)', allAssets.every((a) => a.found_in_source === true));
  check('every asset has verification_status', allAssets.every((a) => a.verification_status));

  // No marineregions-specific behavior anywhere — domain-agnostic.
  const allUrls = allAssets.map((a) => a.url).join(' ');
  check('no marineregions-specific URLs', !/marineregions/i.test(allUrls));
  check('asset URLs are from the github publisher', /github\.com/i.test(allUrls), allAssets[0]?.url);

  check(
    'requirement mapping applied (requirement_ids present)',
    datasets.every((d) => Array.isArray(d.requirement_ids) && d.requirement_ids.length > 0),
  );

  // Version select ran: a family should expose a version and/or superseded list.
  check(
    'version selection produced a latest version or superseded list',
    datasets.some((d) => d.version || (d.superseded_versions && d.superseded_versions.length >= 0)),
  );
}

const MILESTONES = { 1: milestone1, 2: milestone2, 3: milestone3, 4: milestone4, 5: milestone5, 6: milestone6, 7: milestone7, 9: milestone9 };

async function main() {
  console.log(`Phase 2c asset-discovery tests → ${ENDPOINT}`);
  const toRun = ONLY ? [ONLY] : Object.keys(MILESTONES).map(Number);
  for (const m of toRun) {
    if (MILESTONES[m]) await MILESTONES[m]();
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ❌ ${r.name} — ${r.detail}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(2);
});
