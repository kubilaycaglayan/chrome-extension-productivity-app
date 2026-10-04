// Cosmetic artifacts, phase 2 of plans/cosmetic-filtering-performance.md. Everything a
// frame can know before it loads is decided here: which selectors are valid CSS, which
// ones hide an ad on every site, which ones a host cancels, and which ones belong to a
// host. A frame is then left with assembly instead of filtering a 20,660-entry corpus.
//
// Three artifacts come out of it:
//   content/ad-blocker-generic.css          one grouped rule, injected on every page
//   content/ad-blocker-excepted.js          generic selectors some host cancels
//   content/ad-blocker-domain-rules.js      the domain-scoped index, service worker only
//
// Run standalone to regenerate them for the revision the shipped build records, without
// refetching the network lists or reconverting their rules:  node cosmetic.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openChrome } from './chrome.mjs';

export const cosmeticFiles = ['easylist_general_hide.txt', 'easylist_specific_hide.txt', 'easylist_allowlist_general_hide.txt'];

// Cookie and consent banners are left alone: the cookie-accepter module clicks through
// them, and a hidden banner is one the visitor can never dismiss. content/ad-blocker.js
// applies this per frame today; from here on it is applied once, here.
const consent = /(?:cookie|consent|privacy|onetrust|didomi|usercentrics|quantcast|\bcmp\b)/i;
// How many selectors to hand Chrome's CSS parser per round trip.
const probeSize = 2000;

export function parseCosmetic(bodies) {
  const entries = [];
  const skipped = {};
  const skippedSamples = {};
  const skip = (reason, line) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
    (skippedSamples[reason] ||= []).length < 20 && skippedSamples[reason].push(line);
  };
  for (const body of bodies) {
    for (const line of body.split(/\r?\n/)) {
      if (!line || line.startsWith('!')) continue;
      const match = line.match(/^([^#]*)#(#|@#)(.+)$/);
      if (!match) { skip('syntax', line); continue; }
      const [, domainText, marker, selector] = match;
      // Keep plain CSS only. Extended selectors, procedural filters and injected styles need a different engine.
      if (!selector || /[{}]|:|\+|~|\^|\$|\*\*|,|\n/.test(selector) || selector.length > 250) {
        skip('unsupported', line); continue;
      }
      if (!/^[\w\s.#>\[\]="'|*()-]+$/.test(selector)) {
        skip('unsupported', line); continue;
      }
      const domains = domainText ? domainText.split(',').filter(Boolean) : [];
      if (domains.some(domain => !/^~?[a-z0-9.-]+$/i.test(domain))) {
        skip('domain', line); continue;
      }
      entries.push({ selector, domains, exception: marker === '@#' });
    }
  }
  return { entries, skipped, skippedSamples };
}

// The scope of a rule, split the way the artifacts need it. A `~` domain narrows the
// rule rather than placing it; the shipped data has none, but the format keeps them.
const positives = domains => domains.filter(domain => !domain.startsWith('~'));
const negatives = domains => domains.filter(domain => domain.startsWith('~')).map(domain => domain.slice(1));
// A value in the domain index is the selector, or [selector, ...hosts it excludes].
const value = entry => negatives(entry.domains).length ? [entry.selector, ...negatives(entry.domains)] : entry.selector;
const matches = (site, domain) => site === domain || site.endsWith(`.${domain}`);
const applies = (domains, site) =>
  (!positives(domains).length || positives(domains).some(domain => matches(site, domain))) &&
  !negatives(domains).some(domain => matches(site, domain));

function index(entries) {
  const map = new Map();
  for (const entry of entries) {
    for (const domain of positives(entry.domains)) {
      const values = map.get(domain) || map.set(domain, new Map()).get(domain);
      const encoded = value(entry);
      values.set(JSON.stringify(encoded), encoded);
    }
  }
  return Object.fromEntries([...map.keys()].sort().map(domain => [domain, [...map.get(domain).values()]]));
}

// Every selector is checked by the parser that will have to accept it. One rejected
// selector in a grouped rule drops the whole rule, so this cannot be approximated.
async function invalidSelectors(chrome, selectors) {
  const invalid = new Set();
  for (let start = 0; start < selectors.length; start += probeSize) {
    const probe = `(() => {
      const sheet = new CSSStyleSheet();
      return ${JSON.stringify(selectors.slice(start, start + probeSize))}.filter(selector => {
        try { sheet.insertRule(selector + '{}'); sheet.deleteRule(0); return false; } catch { return true; }
      });
    })()`;
    for (const selector of await chrome.evaluate(probe)) invalid.add(selector);
  }
  return invalid;
}

export async function buildCosmetic({ root, revision, bodies }) {
  const { entries, skipped, skippedSamples } = parseCosmetic(bodies);
  const banner = `Generated from EasyList; attribution and license: rules/README.md\nSource revision: ${revision}`;
  const hides = entries.filter(entry => !entry.exception);
  const exceptions = entries.filter(entry => entry.exception);
  const dropped = { consent: hides.filter(entry => consent.test(entry.selector)).map(entry => entry.selector) };
  const supported = hides.filter(entry => !consent.test(entry.selector));

  const chrome = await openChrome();
  try {
    const candidates = [...new Set(supported.map(entry => entry.selector))];
    const invalid = await invalidSelectors(chrome, candidates);
    dropped.invalid = [...invalid];
    // A `#@#` rule with no domain cancels its selector everywhere, so it is applied here
    // rather than shipped. The shipped data has none; an upstream one must not slip past.
    const everywhere = new Set(exceptions.filter(entry => !entry.domains.length).map(entry => entry.selector));
    dropped.cancelledEverywhere = [...everywhere];
    const live = supported.filter(entry => !invalid.has(entry.selector) && !everywhere.has(entry.selector));
    const hidden = new Set(live.map(entry => entry.selector));
    // An exception that cancels nothing left in the corpus is weight with no effect.
    const liveExceptions = exceptions.filter(entry => entry.domains.length && hidden.has(entry.selector));
    dropped.deadExceptions = exceptions.length - everywhere.size - liveExceptions.length;

    const genericSelectors = [...new Set(live.filter(entry => !entry.domains.length).map(entry => entry.selector))];
    const cancelled = new Set(liveExceptions.map(entry => entry.selector));
    // One entry per exception rule rather than a merged domain list per selector, so the
    // content script evaluates exactly the rules EasyList wrote.
    const everywhereHidden = new Set(genericSelectors);
    const excepted = liveExceptions.filter(entry => everywhereHidden.has(entry.selector))
      .map(entry => ({ s: entry.selector, d: entry.domains }));
    const generic = genericSelectors.filter(selector => !cancelled.has(selector));
    const domainHides = index(live.filter(entry => entry.domains.length));
    const domainExceptions = index(liveExceptions.filter(entry => positives(entry.domains).length));
    // An exception scoped only by `~` domains applies to every host but one, which no
    // host key can express; the service worker evaluates these against the host instead.
    const globalExceptions = liveExceptions.filter(entry => !positives(entry.domains).length).map(value);

    const css = `/* ${banner.replace('\n', '\n   ')} */\n${generic.join(',')}{display:none!important}\n`;
    const parsed = await chrome.evaluate(`(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(${JSON.stringify(css)});
      const rule = sheet.cssRules[0];
      return { rules: sheet.cssRules.length, selectors: rule ? rule.selectorText.split(',').length : 0,
        display: rule ? rule.style.getPropertyValue('display') : '', priority: rule ? rule.style.getPropertyPriority('display') : '' };
    })()`);
    if (parsed.rules !== 1 || parsed.selectors !== generic.length || parsed.display !== 'none' || parsed.priority !== 'important') {
      throw new Error(`generic stylesheet did not parse as one rule over ${generic.length} selectors: ${JSON.stringify(parsed)}`);
    }

    verify({ entries, invalid, generic, excepted, domainHides, domainExceptions, globalExceptions });
    await writeFile(resolve(root, 'content/ad-blocker-generic.css'), css);
    await writeFile(resolve(root, 'content/ad-blocker-excepted.js'),
      `// ${banner.replace('\n', '\n// ')}\n// Generic selectors that at least one host cancels, so they stay out of\n// content/ad-blocker-generic.css and are applied per host instead.\nglobalThis.adBlockerExcepted = ${JSON.stringify(excepted)};\n`);
    await writeFile(resolve(root, 'content/ad-blocker-domain-rules.js'),
      `// ${banner.replace('\n', '\n// ')}\n// The domain-scoped corpus, keyed by the domain each rule names. A value is a selector,\n// or [selector, ...hosts the rule excludes]. Loaded by the service worker, never by a page.\n` +
      `export const hides = ${JSON.stringify(domainHides)};\nexport const exceptions = ${JSON.stringify(domainExceptions)};\nexport const globalExceptions = ${JSON.stringify(globalExceptions)};\n`);
    // Still written for content/ad-blocker.js, which phases 4 and 5 move onto the three
    // artifacts above; it goes away with the last reader.
    await writeFile(resolve(root, 'content/ad-blocker-selectors.js'),
      `// ${banner.replace('\n', '\n// ')}\nglobalThis.adBlockerSelectors = ${JSON.stringify(entries)};\n`);

    return {
      output: entries.length, skipped, skippedSamples, validated: candidates.length,
      generic: { file: 'content/ad-blocker-generic.css', bytes: Buffer.byteLength(css), selectors: generic.length },
      excepted: { file: 'content/ad-blocker-excepted.js', entries: excepted.length, selectors: new Set(excepted.map(entry => entry.s)).size },
      domainRules: {
        file: 'content/ad-blocker-domain-rules.js',
        hosts: new Set([...Object.keys(domainHides), ...Object.keys(domainExceptions)]).size,
        hides: Object.values(domainHides).reduce((sum, values) => sum + values.length, 0),
        exceptions: Object.values(domainExceptions).reduce((sum, values) => sum + values.length, 0),
        globalExceptions: globalExceptions.length
      },
      dropped: {
        consent: dropped.consent.length, invalid: dropped.invalid.length,
        cancelledEverywhere: dropped.cancelledEverywhere.length, deadExceptions: dropped.deadExceptions,
        consentSamples: dropped.consent.slice(0, 20), invalidSamples: dropped.invalid.slice(0, 20)
      }
    };
  } finally {
    await chrome.close();
  }
}

// The artifacts are only worth shipping if a host ends up with the selector set the
// current runtime computes for it. Checked against the parsed corpus directly, on every
// host an exception names, a sample of domain-scoped hosts, their subdomains, and a host
// no rule mentions at all.
function verify({ entries, invalid, generic, excepted, domainHides, domainExceptions, globalExceptions }) {
  const current = site => {
    const cancelled = new Set(entries.filter(entry => entry.exception && applies(entry.domains, site)).map(entry => entry.selector));
    return new Set(entries
      .filter(entry => !entry.exception && applies(entry.domains, site) && !cancelled.has(entry.selector))
      .map(entry => entry.selector)
      .filter(selector => !consent.test(selector) && !invalid.has(selector)));
  };
  const suffixes = site => site.split('.').map((_, position, labels) => labels.slice(position).join('.'));
  const scoped = (encoded, site) => Array.isArray(encoded) ? !encoded.slice(1).some(domain => matches(site, domain)) : true;
  const selector = encoded => Array.isArray(encoded) ? encoded[0] : encoded;
  const resolved = site => {
    const keys = suffixes(site);
    const cancelled = new Set([
      ...excepted.filter(entry => applies(entry.d, site)).map(entry => entry.s),
      ...keys.flatMap(key => domainExceptions[key] || []).filter(encoded => scoped(encoded, site)).map(selector),
      ...globalExceptions.filter(encoded => scoped(encoded, site)).map(selector)
    ]);
    // The generic stylesheet is static and injected whole, so nothing a host cancels may
    // be in it; only the per-host parts can have a selector subtracted.
    return new Set([
      ...generic,
      ...[
        ...excepted.map(entry => entry.s),
        ...keys.flatMap(key => domainHides[key] || []).filter(encoded => scoped(encoded, site)).map(selector)
      ].filter(candidate => !cancelled.has(candidate))
    ]);
  };
  // Taken from the parsed corpus rather than from the artifacts, so an artifact that
  // lost a host cannot also lose the check that would have caught it.
  const named = list => [...new Set(list.flatMap(entry => positives(entry.domains)))];
  const hosts = named(entries.filter(entry => entry.exception));
  const sample = named(entries.filter(entry => !entry.exception)).filter((_, position) => position % 20 === 0);
  for (const site of [...hosts, ...sample, ...[...hosts, ...sample].map(host => `www.deep.${host}`), 'nothing-matches-this.invalid']) {
    const expected = [...current(site)].sort();
    const actual = [...resolved(site)].sort();
    if (expected.join('\n') !== actual.join('\n')) {
      const missing = expected.filter(item => !actual.includes(item)).slice(0, 5);
      const extra = actual.filter(item => !expected.includes(item)).slice(0, 5);
      throw new Error(`${site}: artifacts resolve to a different selector set (missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)})`);
    }
  }
}

if (import.meta.filename === process.argv[1]) {
  const root = resolve(import.meta.dirname, '../..');
  const reportPath = resolve(root, 'rules/build-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const revision = process.argv.find(argument => argument.startsWith('--revision='))?.slice(11) || report.revision;
  const bodies = await Promise.all(cosmeticFiles.map(async name => {
    const url = `https://raw.githubusercontent.com/easylist/easylist/${revision}/easylist/${name}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.text();
  }));
  report.cosmetic = await buildCosmetic({ root, revision, bodies });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.cosmetic, null, 2));
}
