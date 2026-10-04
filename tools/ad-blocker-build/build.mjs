import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Filter, FilterConverter } from '@adguard/dnr-converter';

const revision = 'bde0d888ef7c5cb99e9c682b1862988e358d10d6';
const files = [
  'easylist_adservers.txt', 'easylist_allowlist.txt', 'easylist_general_block.txt',
  'easylist_specific_block.txt', 'easylist_thirdparty.txt',
  'easylist_general_hide.txt', 'easylist_specific_hide.txt',
  'easylist_allowlist_general_hide.txt'
];
const root = resolve(import.meta.dirname, '../..');
const sources = await Promise.all(files.map(async name => {
  const url = `https://raw.githubusercontent.com/easylist/easylist/${revision}/easylist/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return { name, url, body: await response.text() };
}));
const network = Object.fromEntries(sources.filter(({ name }) => !name.includes('hide')).map(({ name, body }) => [name, body.split(/\r?\n/).filter(line => line && !line.startsWith('!') && !line.startsWith('['))]));
// This module only blocks ads. Header manipulation and URL rewriting stay out of scope.
const excludedModifiers = /\$(?:[^\s,]*,)*(?:csp|cookie|removeparam|removeheader|redirect|rewrite|urltransform|replace|jsonprune|xmlprune|hls|permissions|popup|webrtc)(?:,|$)/i;
const selected = Object.fromEntries(Object.entries(network).map(([name, lines]) => [name, lines.filter(line => !excludedModifiers.test(line))]));
// Keep all site rules and exceptions in the guaranteed core. Prioritize major ad hosts,
// then distribute the remaining adservers by stable hash instead of alphabetic position.
const adservers = selected['easylist_adservers.txt'];
const priorityHosts = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'amazon-adsystem.com', 'adnxs.com', 'adnxs.net', 'taboola.com',
  'outbrain.com', 'criteo.com', 'pubmatic.com', 'openx.net',
  'rubiconproject.com', 'adsrvr.org', 'smartadserver.com', 'indexww.com'
];
const coreAdserverIndexes = new Set(adservers.map((line, index) => ({
  line, index, priority: priorityHosts.some(host => line.includes(host)),
  rank: createHash('sha256').update(line).digest('hex')
})).sort((a, b) => Number(b.priority) - Number(a.priority) || a.rank.localeCompare(b.rank))
  .slice(0, 24500).map(entry => entry.index));
const coreInput = [...adservers.filter((_, index) => coreAdserverIndexes.has(index)), ...Object.entries(selected).filter(([name]) => name !== 'easylist_adservers.txt').flatMap(([, lines]) => lines)];
const extraInput = adservers.filter((_, index) => !coreAdserverIndexes.has(index));
async function convert(lines, file) {
  const [{ ruleset, errors, limitations }] = await new FilterConverter().convert([new Filter(1, lines.join('\n'))], { maxNumberOfRules: 30000, maxNumberOfRegexpRules: 1000 });
  if (limitations.length) throw new Error(`${file}: ${limitations.map(x => x.message).join('; ')}`);
  const rules = ruleset.getDeclarativeRules();
  if (rules.some(rule => !['block', 'allow', 'allowAllRequests'].includes(rule.action.type))) throw new Error(`${file}: unexpected action`);
  if (rules.length > 30000 || new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error(`${file}: invalid count or IDs`);
  await mkdir(resolve(root, 'rules'), { recursive: true });
  await writeFile(resolve(root, `rules/${file}`), JSON.stringify(rules));
  return { input: lines.length, output: rules.length, errors: errors.length, sampleErrors: errors.slice(0, 50).map(error => String(error)) };
}
const core = await convert(coreInput, 'easylist-ads.json');
const extra = await convert(extraInput, 'easylist-ads-extra.json');

const selectors = [];
const skippedCosmetic = {};
const skippedCosmeticSamples = {};
const skipCosmetic = (reason, line) => {
  skippedCosmetic[reason] = (skippedCosmetic[reason] || 0) + 1;
  (skippedCosmeticSamples[reason] ||= []).length < 20 && skippedCosmeticSamples[reason].push(line);
};
for (const { name, body } of sources.filter(source => source.name.includes('hide'))) {
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
  source: 'EasyList authors', revision, converter: '@adguard/dnr-converter@2.0.0',
  generatedAt: new Date().toISOString(),
  files: sources.map(({ name, url, body }) => ({ name, url, sha256: createHash('sha256').update(body).digest('hex'), lines: body.split(/\r?\n/).length })),
  network: { input: Object.values(network).flat().length, selected: Object.values(selected).flat().length, coreSelection: { adserverCount: coreAdserverIndexes.size, priorityHosts }, excludedModifierSamples: Object.values(network).flat().filter(line => excludedModifiers.test(line)).slice(0, 20), core, extra },
  cosmetic: { output: selectors.length, skipped: skippedCosmetic, skippedSamples: skippedCosmeticSamples }
};
await writeFile(resolve(root, 'rules/build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ network: report.network, cosmetic: report.cosmetic }, null, 2));
