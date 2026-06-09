/**
 * Phase 2c — deterministic post-processing unit tests (M5 core).
 * Run: npx tsx scripts/test-postprocess-core.ts
 *
 * No server / no model — exercises dedup, version compare/select, and family-match
 * application directly, so the D4/dedup/requirement-mismatch logic is provable fast.
 */
import {
  dedupDatasets,
  dedupAssets,
  parseVersionTokens,
  compareDatasetsDesc,
  versionSelect,
  applyFamilyMatches,
  propagateRequirementIds,
  Dataset,
} from '../src/lib/agents/assetDiscovery/postProcessCore';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function ds(partial: Partial<Dataset>): Dataset {
  return {
    dataset_family: 'F',
    dataset_name: 'n',
    version: null,
    release_date: null,
    provider: null,
    source_page: 'http://x/p',
    description: '',
    metadata: {},
    assets: [],
    ...partial,
  };
}
function asset(format: string, url: string) {
  return { format, url, label: format, found_in_source: true };
}

console.log('Phase 2c postProcessCore unit tests\n');

// ── parseVersionTokens ──
console.log('parseVersionTokens:');
check('v12 -> [12]', JSON.stringify(parseVersionTokens(ds({ version: 'v12' }))) === '[12]');
check('v6.1 -> [6,1]', JSON.stringify(parseVersionTokens(ds({ version: 'v6.1' }))) === '[6,1]');
check('from name "World EEZ v11"', JSON.stringify(parseVersionTokens(ds({ version: null, dataset_name: 'World EEZ v11' }))) === '[11]');
check('no version -> null', parseVersionTokens(ds({ version: null, dataset_name: 'World EEZ' })) === null);

// ── compareDatasetsDesc ──
console.log('\ncompareDatasetsDesc (descending = latest first):');
check('v12 before v11', compareDatasetsDesc(ds({ version: 'v12' }), ds({ version: 'v11' })) < 0);
check('v6.1 before v6', compareDatasetsDesc(ds({ version: 'v6.1' }), ds({ version: 'v6' })) < 0);
check(
  'date breaks tie when no version',
  compareDatasetsDesc(
    ds({ version: null, dataset_name: 'D', release_date: '2023-01-01' }),
    ds({ version: null, dataset_name: 'D', release_date: '2020-01-01' }),
  ) < 0,
);

// ── dedup ──
console.log('\ndedup:');
check(
  'dedupAssets removes same (format,url)',
  dedupAssets([asset('shp', 'http://a/x.zip'), asset('shp', 'http://a/x.zip'), asset('kml', 'http://a/x.zip')]).length === 2,
);
{
  const merged = dedupDatasets([
    ds({ dataset_family: 'EEZ', version: 'v12', assets: [asset('shp', 'http://a/1.zip')] }),
    ds({ dataset_family: 'EEZ', version: 'v12', assets: [asset('gpkg', 'http://a/2.zip'), asset('shp', 'http://a/1.zip')] }),
  ]);
  check('dedupDatasets merges same family+version', merged.length === 1, `${merged.length} datasets`);
  check('merged assets deduped', merged[0].assets.length === 2, `${merged[0].assets.length} assets`);
}

// ── versionSelect (D4) ──
console.log('\nversionSelect (D4):');
{
  const families: Dataset[] = [];
  for (let v = 1; v <= 12; v++) {
    families.push(ds({ dataset_family: 'World EEZ', version: `v${v}`, dataset_name: `World EEZ v${v}`, assets: [asset('shp', `http://a/eez_v${v}.zip`)] }));
  }
  // shuffle-ish
  families.reverse();
  const { selected, dropped } = versionSelect(families, false);
  check('collapses to one dataset per family', selected.length === 1, `${selected.length}`);
  check('latest is v12', selected[0].version === 'v12', `latest=${selected[0].version}`);
  check('is_latest=true on survivor', selected[0].is_latest === true);
  check('superseded_versions has 11 entries', selected[0].superseded_versions?.length === 11, `${selected[0].superseded_versions?.length}`);
  check('superseded metadata-only (no assets)', selected[0].superseded_versions!.every((s: any) => !('assets' in s)));
  check('dropped has 11 superseded', dropped.filter((d) => d.reason === 'superseded').length === 11);
}
{
  const fam = [
    ds({ dataset_family: 'World EEZ', version: 'v12', dataset_name: 'World EEZ v12', assets: [asset('shp', 'http://a/v12.zip')] }),
    ds({ dataset_family: 'World EEZ', version: 'v11', dataset_name: 'World EEZ v11', assets: [asset('shp', 'http://a/v11.zip')] }),
  ];
  const { selected } = versionSelect(fam, true);
  check('include_superseded_assets attaches assets', selected[0].superseded_versions!.some((s: any) => Array.isArray(s.assets) && s.assets.length > 0));
}
{
  // Multi-family distinctness: EEZ + 12NM stay separate, each with own latest.
  const multi = [
    ds({ dataset_family: 'World EEZ', version: 'v2', dataset_name: 'World EEZ v2' }),
    ds({ dataset_family: 'World EEZ', version: 'v1', dataset_name: 'World EEZ v1' }),
    ds({ dataset_family: 'World 12NM', version: 'v3', dataset_name: 'World 12NM v3' }),
  ];
  const { selected } = versionSelect(multi, false);
  check('families stay distinct (one latest each)', selected.length === 2);
  const eez = selected.find((d) => d.dataset_family === 'World EEZ');
  const nm = selected.find((d) => d.dataset_family === 'World 12NM');
  check('EEZ latest=v2', eez?.version === 'v2');
  check('12NM latest=v3', nm?.version === 'v3');
}

// ── applyFamilyMatches ([9b] requirement filter, deterministic part) ──
console.log('\napplyFamilyMatches (requirement filter):');
{
  const datasets = [
    ds({ dataset_family: 'World EEZ', version: 'v12' }),
    ds({ dataset_family: 'World 12NM', version: 'v3' }),
    ds({ dataset_family: 'High Seas', version: 'v1' }),
  ];
  const matchMap = new Map<string, string[]>([['world eez', ['r1']]]);
  const { kept, dropped } = applyFamilyMatches(datasets, matchMap, ['r1']);
  check('keeps only matched family', kept.length === 1 && kept[0].dataset_family === 'World EEZ', `kept=${kept.map((k) => k.dataset_family)}`);
  check('kept gets requirement_ids', JSON.stringify(kept[0].requirement_ids) === '["r1"]');
  check('unmatched -> requirement_mismatch', dropped.filter((d) => d.reason === 'requirement_mismatch').length === 2, `${dropped.length} dropped`);
  check('dropped names the families', dropped.every((d) => d.dataset_family && /12NM|High Seas/.test(d.dataset_family)));
}
{
  // Empty requirement_ids in match -> fallback ids applied.
  const datasets = [ds({ dataset_family: 'World EEZ' })];
  const { kept } = applyFamilyMatches(datasets, new Map([['world eez', []]]), ['rX']);
  check('empty match ids fall back to provided ids', JSON.stringify(kept[0].requirement_ids) === '["rX"]');
}

// ── propagateRequirementIds ([11] D9) ──
console.log('\npropagateRequirementIds (D9):');
{
  const d = ds({
    dataset_family: 'World EEZ',
    requirement_ids: ['r1'],
    assets: [asset('shp', 'http://a/v12.zip'), asset('gpkg', 'http://a/v12g.zip')],
    superseded_versions: [{ version: 'v11', assets: [asset('shp', 'http://a/v11.zip')] }],
  });
  propagateRequirementIds([d], ['fallback']);
  check('assets inherit dataset requirement_ids', d.assets.every((a: any) => JSON.stringify(a.requirement_ids) === '["r1"]'));
  check('superseded entries inherit requirement_ids', (d.superseded_versions as any)[0].requirement_ids[0] === 'r1');
  check('superseded assets inherit requirement_ids', (d.superseded_versions as any)[0].assets[0].requirement_ids[0] === 'r1');
}
{
  const d = ds({ dataset_family: 'X', assets: [asset('shp', 'http://a/x.zip')] }); // no requirement_ids
  propagateRequirementIds([d], ['rFallback']);
  check('missing requirement_ids -> fallback on dataset', JSON.stringify(d.requirement_ids) === '["rFallback"]');
  check('missing requirement_ids -> fallback on assets', JSON.stringify((d.assets[0] as any).requirement_ids) === '["rFallback"]');
}

console.log(`\n${'='.repeat(50)}\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
