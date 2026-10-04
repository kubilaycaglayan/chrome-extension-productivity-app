import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Filter, FilterConverter } from '@adguard/dnr-converter';

// EasyList supplies the ad rules and EasyPrivacy the tracker rules. Both ship from
// the same upstream repository, so one pinned commit covers the pair.
const revision = 'bde0d888ef7c5cb99e9c682b1862988e358d10d6';
const lists = [
  {
    id: 'easylist',
    name: 'EasyList',
    directory: 'easylist',
    homepage: 'https://easylist.to/',
    license: 'GPL-3.0-or-later and CC BY-SA 3.0 Unported',
    network: [
      'easylist_adservers.txt', 'easylist_allowlist.txt', 'easylist_general_block.txt',
      'easylist_specific_block.txt', 'easylist_thirdparty.txt'
    ],
    cosmetic: ['easylist_general_hide.txt', 'easylist_specific_hide.txt', 'easylist_allowlist_general_hide.txt'],
    // A flat host pool far larger than the guaranteed capacity: split across sets.
    pooled: ['easylist_adservers.txt']
  },
  {
    id: 'easyprivacy',
    name: 'EasyPrivacy',
    directory: 'easyprivacy',
    homepage: 'https://easylist.to/',
    license: 'GPL-3.0-or-later and CC BY-SA 3.0 Unported',
    // Tracker rules only. The CNAME-tracker and email-tracker lists are separate
    // upstream add-ons and stay out of scope; so do the cosmetic and annoyance lists.
    network: [
      'easyprivacy_general.txt', 'easyprivacy_specific.txt', 'easyprivacy_specific_international.txt',
      'easyprivacy_thirdparty.txt', 'easyprivacy_thirdparty_international.txt',
      'easyprivacy_allowlist.txt', 'easyprivacy_allowlist_international.txt',
      'easyprivacy_trackingservers.txt', 'easyprivacy_trackingservers_general.txt',
      'easyprivacy_trackingservers_thirdparty.txt', 'easyprivacy_trackingservers_international.txt'
    ],
    cosmetic: [],
    pooled: []
  }
];
// Chrome guarantees 30,000 static rules per extension; anything beyond that needs
// capacity in the pool shared with other extensions. The core stays inside the
// guarantee, and each supplemental set is kept small enough to be the one that fits.
const coreInputBudget = 29400;
const supplementalRuleBudget = 30000;
const supplementalFiles = ['easylist-ads-extra.json', 'easylist-ads-extra-2.json'];

const root = resolve(import.meta.dirname, '../..');
const sources = (await Promise.all(lists.map(list => Promise.all([...list.network, ...list.cosmetic].map(async name => {
  const url = `https://raw.githubusercontent.com/easylist/easylist/${revision}/${list.directory}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return { list: list.id, name, url, body: await response.text(), cosmetic: list.cosmetic.includes(name) };
}))))).flat();
const network = Object.fromEntries(sources.filter(source => !source.cosmetic).map(({ name, body }) => [name, body.split(/\r?\n/).filter(line => line && !line.startsWith('!') && !line.startsWith('['))]));
// This module only blocks ads and trackers. Header manipulation and URL rewriting
// stay out of scope, in the bare `$csp` and the `$csp=value` forms alike.
const excludedModifiers = /\$(?:[^\s,]*,)*(?:csp|cookie|removeparam|removeheader|redirect|rewrite|urltransform|replace|jsonprune|xmlprune|hls|permissions|popup|webrtc)(?:=[^,]*)?(?:,|$)/i;
const selected = Object.fromEntries(Object.entries(network).map(([name, lines]) => [name, lines.filter(line => !excludedModifiers.test(line))]));
// Everything that is not a pooled host list is guaranteed, so a supplemental set that
// cannot load never strands a block rule whose exception lives elsewhere. Pooled hosts
// then fill the rest of the core: major ad networks first, then a stable hash order so
// the selection does not drift with alphabetic position between refreshes.
const pooledNames = lists.flatMap(list => list.pooled);
const guaranteed = Object.entries(selected).filter(([name]) => !pooledNames.includes(name)).flatMap(([, lines]) => lines);
const pooled = pooledNames.flatMap(name => selected[name]);
const priorityHosts = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'amazon-adsystem.com', 'adnxs.com', 'adnxs.net', 'taboola.com',
  'outbrain.com', 'criteo.com', 'pubmatic.com', 'openx.net',
  'rubiconproject.com', 'adsrvr.org', 'smartadserver.com', 'indexww.com'
];
const corePooledCount = Math.max(0, coreInputBudget - guaranteed.length);
const ranked = pooled.map(line => ({
  line, priority: priorityHosts.some(host => line.includes(host)),
  rank: createHash('sha256').update(line).digest('hex')
})).sort((a, b) => Number(b.priority) - Number(a.priority) || a.rank.localeCompare(b.rank)).map(entry => entry.line);
const coreInput = [...ranked.slice(0, corePooledCount), ...guaranteed];
// Spread the overflow evenly instead of filling the first set, so partial shared
// capacity admits roughly half the remaining rules either way.
const overflow = ranked.slice(corePooledCount);
const chunkSize = Math.ceil(overflow.length / supplementalFiles.length);
if (chunkSize > supplementalRuleBudget) throw new Error(`overflow needs more than ${supplementalFiles.length} supplemental sets`);
const supplementalInput = supplementalFiles.map((_, index) => overflow.slice(index * chunkSize, (index + 1) * chunkSize));

async function convert(lines, file, maxNumberOfRules) {
  const [{ ruleset, errors, limitations }] = await new FilterConverter().convert([new Filter(1, lines.join('\n'))], { maxNumberOfRules, maxNumberOfRegexpRules: 1000 });
  if (limitations.length) throw new Error(`${file}: ${limitations.map(x => x.message).join('; ')}`);
  const rules = ruleset.getDeclarativeRules();
  if (rules.some(rule => !['block', 'allow', 'allowAllRequests'].includes(rule.action.type))) throw new Error(`${file}: unexpected action`);
  if (rules.length > maxNumberOfRules || new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error(`${file}: invalid count or IDs`);
  await mkdir(resolve(root, 'rules'), { recursive: true });
  await writeFile(resolve(root, `rules/${file}`), JSON.stringify(rules));
  return { input: lines.length, output: rules.length, errors: errors.length, sampleErrors: errors.slice(0, 50).map(error => String(error)) };
}
const core = await convert(coreInput, 'easylist-ads.json', 30000);
const supplemental = [];
for (const [index, file] of supplementalFiles.entries()) supplemental.push({ file, ...await convert(supplementalInput[index], file, supplementalRuleBudget) });

const selectors = [];
const skippedCosmetic = {};
const skippedCosmeticSamples = {};
const skipCosmetic = (reason, line) => {
  skippedCosmetic[reason] = (skippedCosmetic[reason] || 0) + 1;
  (skippedCosmeticSamples[reason] ||= []).length < 20 && skippedCosmeticSamples[reason].push(line);
};
for (const { body } of sources.filter(source => source.cosmetic)) {
  for (const line of body.split(/\r?\n/)) {
    if (!line || line.startsWith('!')) continue;
    const match = line.match(/^([^#]*)#(#|@#)(.+)$/);
    if (!match) { skipCosmetic('syntax', line); continue; }
    const [, domainText, marker, selector] = match;
    // Keep plain CSS only. Extended selectors, procedural filters and injected styles need a different engine.
    if (!selector || /[{}]|:|\+|~|\^|\$|\*\*|,|\n/.test(selector) || selector.length > 250) {
      skipCosmetic('unsupported', line); continue;
    }
    if (!/^[\w\s.#>\[\]="'|*()-]+$/.test(selector)) {
      skipCosmetic('unsupported', line); continue;
    }
    const domains = domainText ? domainText.split(',').filter(Boolean) : [];
    if (domains.some(domain => !/^~?[a-z0-9.-]+$/i.test(domain))) {
      skipCosmetic('domain', line); continue;
    }
    selectors.push({ selector, domains, exception: marker === '@#' });
  }
}
await writeFile(resolve(root, 'content/ad-blocker-selectors.js'), `// Generated from EasyList; attribution and license: rules/README.md\n// Source revision: ${revision}\nglobalThis.adBlockerSelectors = ${JSON.stringify(selectors)};\n`);
const report = {
  sources: lists.map(({ name, directory, homepage, license }) => ({ name, directory, homepage, license })),
  revision, converter: '@adguard/dnr-converter@2.0.0',
  generatedAt: new Date().toISOString(),
  files: sources.map(({ list, name, url, body }) => ({ list, name, url, sha256: createHash('sha256').update(body).digest('hex'), lines: body.split(/\r?\n/).length })),
  network: {
    input: Object.values(network).flat().length,
    selected: Object.values(selected).flat().length,
    coreSelection: { guaranteedCount: guaranteed.length, pooledFiles: pooledNames, pooledCount: pooled.length, corePooledCount, priorityHosts },
    excludedModifierSamples: Object.values(network).flat().filter(line => excludedModifiers.test(line)).slice(0, 20),
    core, supplemental
  },
  cosmetic: { output: selectors.length, skipped: skippedCosmetic, skippedSamples: skippedCosmeticSamples }
};
await writeFile(resolve(root, 'rules/build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ network: report.network, cosmetic: report.cosmetic }, null, 2));
