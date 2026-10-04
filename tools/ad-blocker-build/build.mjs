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
    // Flat tracking-host lists, pooled for the same reason as the EasyList adservers.
    pooled: [
      'easyprivacy_trackingservers.txt', 'easyprivacy_trackingservers_general.txt',
      'easyprivacy_trackingservers_thirdparty.txt', 'easyprivacy_trackingservers_international.txt'
    ]
  }
];

// Neither EasyList nor EasyPrivacy covers device and mobile-OS telemetry, so the
// AdGuard Tracking Protection and Mobile Ads filters supply that. Their repository
// sources need `!#include` and `!#if` preprocessing, and the includes point at
// unpinned URLs, so the compiled chromium platform build is taken instead: it has
// the includes resolved and the platform conditionals already evaluated for a
// Chromium extension. Each build is one file delimited by section banners, so
// sections are selected by name the way the EasyList lists select files.
const adguardLists = [
  {
    id: 'adguard_tracking',
    name: 'AdGuard Tracking Protection filter',
    filterId: 3,
    homepage: 'https://github.com/AdguardTeam/AdguardFilters',
    license: 'GPL-3.0-only',
    sections: [
      'General (unsorted) url blocking', 'Specific web sites', 'Mobile analytics',
      'Mobile analytics exceptions', 'Fixing filtration errors (false-positive)'
    ],
    // The third-party tracker host list, far past the guaranteed capacity on its own.
    pooled: ['Tracking servers list'],
    // Cookie rules need $cookie, which this module does not do; the CNAME mail
    // tracker block is the separate email-tracker add-on, out of scope here as it
    // is for EasyPrivacy; the rest are cosmetic and scriptlet sections.
    skip: [
      'CNAME mail trackers', 'Fixing filtration errors (false-positive) Cookies',
      'General rules - Cookies', 'Specific rules - Cookies',
      'General javascript, CSS and HTML extensions', 'General hiding rules',
      // Already bundled from EasyPrivacy upstream in full.
      'Including a part of domains from EasyPrivacy'
    ]
  },
  {
    id: 'adguard_mobile',
    name: 'AdGuard Mobile Ads filter',
    filterId: 11,
    homepage: 'https://github.com/AdguardTeam/AdguardFilters',
    license: 'GPL-3.0-only',
    sections: [
      'Advertising networks', 'For HTTPS websites when HTTPS filtering is disabled',
      'General URL blocking rules', 'Fixing filtration errors (false-positive)',
      'Rules for specific websites'
    ],
    pooled: [],
    // Native-app traffic never reaches an extension; anti-adblock circumvention and
    // content replacement are out of scope; the rest are cosmetic.
    skip: [
      'Rules for specific applications', 'Anti-adblock rules', 'Content replacement rules',
      'General element hiding rules', 'popular banner sizes',
      'General javascript, CSS and HTML extensions'
    ]
  }
];

// Chrome guarantees 30,000 static rules per extension; anything beyond that needs
// capacity in the pool shared with other extensions. The core stays inside the
// guarantee, and each supplemental set is kept small enough to be the one that fits.
const coreInputBudget = 29400;
const supplementalRuleBudget = 30000;
const supplementalFiles = [
  'easylist-ads-extra.json', 'easylist-ads-extra-2.json', 'easylist-ads-extra-3.json',
  'easylist-ads-extra-4.json', 'easylist-ads-extra-5.json', 'easylist-ads-extra-6.json'
];

const root = resolve(import.meta.dirname, '../..');
const sources = (await Promise.all(lists.map(list => Promise.all([...list.network, ...list.cosmetic].map(async name => {
  const url = `https://raw.githubusercontent.com/easylist/easylist/${revision}/${list.directory}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return { list: list.id, name, url, body: await response.text(), cosmetic: list.cosmetic.includes(name) };
}))))).flat();
const adguardSources = await Promise.all(adguardLists.map(async list => {
  const url = `https://filters.adtidy.org/extension/chromium/filters/${list.filterId}.txt`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return { list, url, body: await response.text() };
}));

// Cosmetic, scriptlet and HTML-filtering syntax in any of its markers. These lists
// interleave it with network rules, so it is dropped per line rather than per file.
const cosmeticSyntax = /#[@%?$]?#|#\$\?#|\$\$|\$@\$/;
// Segment each AdGuard build on its section banners and keep only the named sections.
// An unknown section name is a build break rather than a silent omission, so that an
// upstream rename surfaces at refresh time instead of quietly dropping its rules.
const adguardSegments = [];
const adguardMeta = [];
for (const { list, url, body } of adguardSources) {
  let section = '(preamble)';
  const seen = new Map([[section, []]]);
  for (const line of body.split(/\r?\n/)) {
    const banner = line.match(/^!-{2,} (.*?)\s*-{2,}!?$/);
    if (banner) { section = banner[1].trim(); if (!seen.has(section)) seen.set(section, []); continue; }
    if (!line || line.startsWith('!') || line.startsWith('[') || cosmeticSyntax.test(line)) continue;
    seen.get(section).push(line);
  }
  const declared = new Set([...list.sections, ...list.pooled, ...list.skip, '(preamble)']);
  const undeclared = [...seen.keys()].filter(name => !declared.has(name));
  if (undeclared.length) throw new Error(`${list.name}: undeclared sections ${JSON.stringify(undeclared)}`);
  for (const name of [...list.sections, ...list.pooled]) {
    if (!seen.has(name)) throw new Error(`${list.name}: section "${name}" is gone upstream`);
    adguardSegments.push({ list: list.id, name, lines: seen.get(name), pooled: list.pooled.includes(name) });
  }
  const header = Object.fromEntries(['Title', 'Version', 'TimeUpdated', 'Checksum']
    .map(key => [key, body.match(new RegExp(`^! ${key}: (.*)$`, 'm'))?.[1] ?? null]));
  adguardMeta.push({
    list: list.id, url, ...header,
    sha256: createHash('sha256').update(body).digest('hex'), lines: body.split(/\r?\n/).length,
    selected: Object.fromEntries([...list.sections, ...list.pooled].map(name => [name, seen.get(name).length])),
    skipped: Object.fromEntries(list.skip.filter(name => seen.has(name)).map(name => [name, seen.get(name).length]))
  });
}

const network = Object.fromEntries(sources.filter(source => !source.cosmetic).map(({ name, body }) => [name, body.split(/\r?\n/).filter(line => line && !line.startsWith('!') && !line.startsWith('['))]));
// This module only blocks ads and trackers. Header manipulation, URL rewriting and
// cosmetic-scope modifiers stay out of scope, in the bare `$csp` and the `$csp=value`
// forms alike. The AdGuard lists add app-, stealth- and extension-only modifiers that
// mean nothing to declarativeNetRequest.
const excludedModifiers = /\$(?:[^\s,]*,)*(?:csp|cookie|removeparam|removeheader|redirect|rewrite|urltransform|replace|jsonprune|xmlprune|hls|permissions|popup|webrtc|app|network|extension|stealth|jsinject|urlblock|content|elemhide|generichide|specifichide|empty|mp4|badfilter|referrerpolicy|cname)(?:=[^,]*)?(?:,|$)/i;
const selected = Object.fromEntries(Object.entries(network).map(([name, lines]) => [name, lines.filter(line => !excludedModifiers.test(line))]));
const adguardSelected = adguardSegments.map(segment => ({ ...segment, lines: segment.lines.filter(line => !excludedModifiers.test(line)) }));
// Everything that is not a pooled host list is guaranteed, so a supplemental set that
// cannot load never strands a block rule whose exception lives elsewhere. Pooled hosts
// then fill the rest of the core: major ad networks first, then a stable hash order so
// the selection does not drift with alphabetic position between refreshes.
const pooledNames = lists.flatMap(list => list.pooled);
const guaranteed = [...new Set([
  ...Object.entries(selected).filter(([name]) => !pooledNames.includes(name)).flatMap(([, lines]) => lines),
  ...adguardSelected.filter(segment => !segment.pooled).flatMap(segment => segment.lines)
])];
const guaranteedSet = new Set(guaranteed);
// The lists overlap heavily on tracker hosts, so the pool is deduplicated against
// itself and against the core rather than paying for the same host several times.
const pooled = [...new Set([
  ...pooledNames.flatMap(name => selected[name]),
  ...adguardSelected.filter(segment => segment.pooled).flatMap(segment => segment.lines)
])].filter(line => !guaranteedSet.has(line));
const priorityHosts = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'amazon-adsystem.com', 'adnxs.com', 'adnxs.net', 'taboola.com',
  'outbrain.com', 'criteo.com', 'pubmatic.com', 'openx.net',
  'rubiconproject.com', 'adsrvr.org', 'smartadserver.com', 'indexww.com'
];
if (guaranteed.length > coreInputBudget) throw new Error(`guaranteed rules (${guaranteed.length}) exceed the core budget (${coreInputBudget})`);
// No exception may sit outside the core, or a supplemental set that fails to load
// would leave its block rule enforced with nothing to override it.
const strandedExceptions = pooled.filter(line => line.startsWith('@@')).length;
if (strandedExceptions) throw new Error(`${strandedExceptions} exception rules landed in the pool`);
const corePooledCount = Math.max(0, coreInputBudget - guaranteed.length);
const ranked = pooled.map(line => ({
  line, priority: priorityHosts.some(host => line.includes(host)),
  rank: createHash('sha256').update(line).digest('hex')
})).sort((a, b) => Number(b.priority) - Number(a.priority) || a.rank.localeCompare(b.rank)).map(entry => entry.line);
const coreInput = [...ranked.slice(0, corePooledCount), ...guaranteed];
// Spread the overflow evenly instead of filling the first set, so partial shared
// capacity admits a proportional share of the remaining rules either way.
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
  sources: [
    ...lists.map(({ name, directory, homepage, license }) => ({ name, directory, homepage, license })),
    ...adguardLists.map(({ name, filterId, homepage, license }) => ({ name, filterId, homepage, license }))
  ],
  revision, converter: '@adguard/dnr-converter@2.0.0',
  generatedAt: new Date().toISOString(),
  files: sources.map(({ list, name, url, body }) => ({ list, name, url, sha256: createHash('sha256').update(body).digest('hex'), lines: body.split(/\r?\n/).length })),
  // The AdGuard platform builds carry no commit to pin, so the list version, upstream
  // timestamp and a content hash stand in for one.
  adguard: adguardMeta,
  network: {
    input: Object.values(network).flat().length + adguardSegments.reduce((sum, segment) => sum + segment.lines.length, 0),
    selected: Object.values(selected).flat().length + adguardSelected.reduce((sum, segment) => sum + segment.lines.length, 0),
    coreSelection: {
      guaranteedCount: guaranteed.length,
      pooledFiles: [...pooledNames, ...adguardSelected.filter(segment => segment.pooled).map(segment => `${segment.list}: ${segment.name}`)],
      pooledCount: pooled.length, corePooledCount, priorityHosts
    },
    excludedModifierSamples: Object.values(network).flat().filter(line => excludedModifiers.test(line)).slice(0, 20),
    core, supplemental
  },
  cosmetic: { output: selectors.length, skipped: skippedCosmetic, skippedSamples: skippedCosmeticSamples }
};
await writeFile(resolve(root, 'rules/build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ adguard: adguardMeta.map(({ list, Version, selected, skipped }) => ({ list, Version, selected, skipped })), network: report.network, cosmetic: report.cosmetic }, null, 2));
