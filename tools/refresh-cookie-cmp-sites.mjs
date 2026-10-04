// Re-snapshots the DuckDuckGo autoconsent CMP corpus into tests/fixtures/cookie-cmp-sites.json.
// Only site lists and CMP labels are copied, as an attributed snapshot of MPL-2.0 data; no rule
// code enters this repository. Refresh with: node tools/refresh-cookie-cmp-sites.mjs
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'https://raw.githubusercontent.com/duckduckgo/autoconsent/main';
const coverageUrl = `${repo}/data/coverage.json`;

// Static fake-CMP pages. They always render a banner, so they score the same from any region.
const fixturePages = [
  { url: 'https://privacy-test-pages.site/features/autoconsent/', label: 'normal popup' },
  { url: 'https://privacy-test-pages.site/features/autoconsent/banner.html', label: 'cookie banner element' },
  { url: 'https://privacy-test-pages.site/features/autoconsent/heuristic.html', label: 'heuristic-only popup' },
  { url: 'https://privacy-test-pages.site/features/autoconsent/filterlist.html', label: 'filterlist popup' },
  { url: 'https://privacy-test-pages.site/features/autoconsent/reload-loop.html', label: 'reload loop guard' }
];

// Each extension adapter, mapped to the autoconsent rule names and spec files covering the same CMP.
const adapters = {
  OneTrust: { coverage: ['Onetrust'], specs: ['onetrust'] },
  Cookiebot: { coverage: ['Cybotcookiebot'], specs: ['cookiebot', 'cookiebot-be'] },
  Didomi: { coverage: ['didomi'], specs: ['didomi'] },
  Usercentrics: { coverage: ['usercentrics-api', 'usercentrics-button'], specs: ['usercentrics-api', 'usercentrics-button'] },
  Quantcast: { coverage: ['quantcast'], specs: ['quantcast'] }
};
const otherSitesPerCmp = 2;

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

// Each generateCMPTests(...) call lists sites and then its own region options, so the text between
// one call and the next is the scope of those options. Commented-out sites are intentionally
// disabled upstream (bot walls, flaky banners), so they are dropped here too.
function parseSpec(source) {
  const sites = [];
  const uncommented = source.replace(/(^|\s)\/\/.*$/gm, '$1');
  const calls = uncommented.split('generateCMPTests(').slice(1);
  for (const call of calls) {
    const only = call.match(/onlyRegions:\s*\[([^\]]*)\]/);
    const skip = call.match(/skipRegions:\s*\[([^\]]*)\]/);
    const regions = text => (text ? [...text.matchAll(/'([A-Z]{2})'/g)].map(match => match[1]) : []);
    for (const match of call.matchAll(/['"](https?:\/\/[^'"]+)['"]/g)) {
      sites.push({ url: match[1], onlyRegions: regions(only?.[1]), skipRegions: regions(skip?.[1]) });
    }
  }
  if (!sites.length) throw new Error('No sites parsed; the autoconsent spec shape changed.');
  return sites;
}

const coverage = JSON.parse(await fetchText(coverageUrl));
if (!coverage.Onetrust) throw new Error('coverage.json is missing expected CMP keys; the source shape changed.');

const supported = new Set(Object.values(adapters).flatMap(adapter => adapter.coverage));
const snapshot = { adapters: {}, other: [] };

for (const [name, adapter] of Object.entries(adapters)) {
  const seen = new Map();
  const add = (url, onlyRegions, skipRegions, cmp) => {
    const existing = seen.get(url);
    if (existing) {
      // A site listed by both sources keeps the wider scope.
      if (!onlyRegions.length) existing.onlyRegions = [];
      else if (existing.onlyRegions.length) existing.onlyRegions = [...new Set([...existing.onlyRegions, ...onlyRegions])];
      existing.skipRegions = existing.skipRegions.filter(region => skipRegions.includes(region));
      return;
    }
    seen.set(url, { url, cmp, onlyRegions, skipRegions });
  };
  for (const cmp of adapter.coverage) {
    for (const [region, data] of Object.entries(coverage[cmp] ?? {})) {
      for (const url of data.exampleSites ?? []) add(url, [region], [], cmp);
    }
  }
  for (const spec of adapter.specs) {
    const source = await fetchText(`${repo}/tests/${spec}.spec.ts`);
    for (const site of parseSpec(source)) add(site.url, site.onlyRegions, site.skipRegions, adapter.coverage[0]);
  }
  snapshot.adapters[name] = [...seen.values()];
}

// Sites behind CMPs the extension has no adapter for. Scoring them measures remaining headroom.
for (const [cmp, regions] of Object.entries(coverage)) {
  if (supported.has(cmp)) continue;
  for (const [region, data] of Object.entries(regions)) {
    for (const url of (data.exampleSites ?? []).slice(0, otherSitesPerCmp)) {
      snapshot.other.push({ url, cmp, onlyRegions: [region], skipRegions: [] });
    }
  }
}

const total = Object.values(snapshot.adapters).reduce((sum, sites) => sum + sites.length, 0);
await writeFile(resolve(root, 'tests/fixtures/cookie-cmp-sites.json'), JSON.stringify({
  source: 'https://github.com/duckduckgo/autoconsent (data/coverage.json and tests/*.spec.ts, MPL-2.0)',
  retrieved: new Date().toISOString().slice(0, 10),
  note: 'Site lists and CMP labels only. Refresh with tools/refresh-cookie-cmp-sites.mjs; score with tools/score-cookie-test.mjs.',
  fixturePages,
  adapters: snapshot.adapters,
  other: snapshot.other
}, null, 2) + '\n');
console.log(`Saved ${fixturePages.length} fixture pages, ${total} adapter sites, ${snapshot.other.length} out-of-scope sites`);
