const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const core = JSON.parse(fs.readFileSync(path.join(root, 'rules/easylist-ads.json')));
const supplementalResources = manifest.declarative_net_request.rule_resources.filter(resource => resource.id !== 'easylist_ads');
const supplemental = supplementalResources.map(resource => JSON.parse(fs.readFileSync(path.join(root, resource.path))));

test('packaged rules are within guaranteed core and supplemental quotas, with exceptions and site conditions', () => {
  assert.equal(manifest.permissions.includes('declarativeNetRequestWithHostAccess'), true);
  assert.equal(manifest.declarative_net_request.rule_resources.length, 7);
  // Only the core may load from the manifest; the rest are enabled at runtime so a
  // set that does not fit the shared static quota cannot keep the others out.
  assert.equal(manifest.declarative_net_request.rule_resources.filter(resource => resource.enabled).map(resource => resource.id).join(), 'easylist_ads');
  assert.ok(core.length > 25000 && core.length < 30000);
  for (const rules of supplemental) assert.ok(rules.length > 15000 && rules.length < 30000);
  for (const rules of [core, ...supplemental]) {
    assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
    assert.ok(rules.every(rule => ['block', 'allow', 'allowAllRequests'].includes(rule.action.type)));
    assert.ok(rules.every(rule => !rule.condition.regexFilter));
  }
  for (const host of ['doubleclick.net', 'amazon-adsystem.com', 'adnxs.com', 'pubmatic.com', 'openx.net', 'taboola.com', 'outbrain.com']) {
    assert.ok(core.some(rule => rule.action.type === 'block' && rule.condition.urlFilter?.includes(host)), `${host} must be in the guaranteed core`);
  }
  assert.ok(core.some(rule => rule.action.type === 'allow' && rule.condition.initiatorDomains?.length && rule.condition.resourceTypes?.length));
  assert.ok(core.some(rule => rule.action.type === 'block' && rule.condition.initiatorDomains?.length));
  // A supplemental set may fail to load, so no exception may live outside the core.
  assert.equal(supplemental.some(rules => rules.some(rule => rule.action.type !== 'block')), false);
  // The cosmetic layer is registered from modules/ad-blocker.js rather than declared here.
  // A declared entry would apply the generic stylesheet on every host, including one the
  // user paused, and Chrome gives a frame no way to take injected CSS back off.
  assert.deepEqual(manifest.content_scripts.filter(entry => entry.js.some(file => file.includes('ad-blocker'))), []);
  assert.equal(manifest.permissions.includes('scripting'), true);
  // A frame is handed the 275 generic rules some host cancels and nothing else; the
  // 1.4 MB corpus it used to parse per frame is now resolved at build time and in the
  // service worker.
  assert.ok(fs.statSync(path.join(root, 'content/ad-blocker-excepted.js')).size < 50000);
});

// The host map is precomputed, so the service worker's whole job is the suffix walk:
// a host's rules are the union of every suffix of its name, minus what it cancels.
const domainRules = {
  hides: {
    'news.example': ['.news-ad'],
    'example.com': ['.parent-ad', ['.narrowed', 'skip.example.com']],
    'news.example.com': ['.child-ad']
  },
  exceptions: { 'news.example.com': ['.parent-ad'] },
  // Cancels .narrowed everywhere but one host, which no host key can express.
  globalExceptions: [['.narrowed', 'keep.example.com']]
};

const loadModule = () => {
  const source = fs.readFileSync(path.join(root, 'modules/ad-blocker.js'), 'utf8')
    .replace(/^import .*$/m, 'const { hides, exceptions, globalExceptions } = this.domainRules;')
    .replaceAll('export function ', 'function ') + '\nthis.api = { cleanPausedSites, resolveCosmetic, cosmeticScripts, initializeAdBlocker };';
  return source;
};

// Values cross the VM boundary, so they are rebuilt in this realm before `assert/strict`
// compares them against plain objects and arrays.
const plain = value => JSON.parse(JSON.stringify(value));

test('the cosmetic registration keeps the per-host script apart from the generic stylesheet', () => {
  const context = { domainRules, chrome: {}, console, URL };
  vm.runInNewContext(loadModule(), context);
  const scripts = (enabled, sites = []) => plain(context.api.cosmeticScripts(enabled, sites));

  // The per-host script is registered whether the module is on or off: a frame already open
  // has to be able to adopt its sheet again when the setting comes back, and the sheet it
  // adopts is its own, so leaving the script in place costs a disabled module nothing.
  const off = scripts(false);
  assert.deepEqual(off.map(script => script.id), ['ad-blocker-cosmetic']);
  assert.deepEqual(off[0], {
    id: 'ad-blocker-cosmetic',
    js: ['content/ad-blocker-excepted.js', 'content/ad-blocker.js'],
    matches: ['<all_urls>'],
    allFrames: true,
    runAt: 'document_start'
  });
  // Injected CSS is the half a frame cannot take back off, so it is only registered while
  // the module is on. Both halves run at document_start in every frame, which is what puts
  // generic hiding in front of first paint.
  const on = scripts(true);
  assert.deepEqual(on[0], off[0]);
  assert.deepEqual(on[1], {
    id: 'ad-blocker-generic',
    css: ['content/ad-blocker-generic.css'],
    matches: ['<all_urls>'],
    allFrames: true,
    runAt: 'document_start'
  });
  // A paused hostname is excluded along with its subdomains, matching the way the service
  // worker and the content script read the same list.
  assert.deepEqual(scripts(true, ['paused.example', 'other.example'])[1].excludeMatches, [
    '*://paused.example/*', '*://*.paused.example/*', '*://other.example/*', '*://*.other.example/*'
  ]);
  // An IP literal has no subdomains, and `cleanPausedSites` accepts one, so it gets the
  // bare pattern rather than a `*.` pattern Chrome has no reason to accept.
  assert.deepEqual(scripts(true, ['127.0.0.1'])[1].excludeMatches, ['*://127.0.0.1/*']);
  for (const file of [...on[0].js, ...on[1].css]) assert.ok(fs.existsSync(path.join(root, file)), `${file} is registered but missing`);
});

test('the generic stylesheet is grouped rules Chrome can parse and match whole', () => {
  const css = fs.readFileSync(path.join(root, 'content/ad-blocker-generic.css'), 'utf8');
  // An attribution banner, which the license requires, and then one display:none rule per
  // line. Grouping means one invalid selector would drop every selector sharing its rule,
  // so the shape is pinned here and the selectors are validated in Chrome at build time.
  const [, banner, body] = css.match(/^(\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\/\n)([\s\S]+)$/) || [];
  assert.ok(body, 'the stylesheet must open with a comment banner');
  assert.match(banner, /EasyList/);
  const rules = body.replace(/\n$/, '').split('\n');
  const groups = rules.map(rule => (rule.match(/^([^{}]+)\{display:none!important\}$/) || [])[1]);
  assert.deepEqual(groups.filter(group => !group), [], 'every rule must be one display:none group');
  assert.equal(css.split('{').length - 1, rules.length);
  assert.equal(css.split('}').length - 1, rules.length);
  // Blink indexes a rule's selectors in 13 bits, counting CSSSelector entries rather than
  // list positions, so a selector starting past entry 8191 of its rule is parsed and kept
  // but never matched. One rule over all 12,980 selectors lost 37% of them that way, which
  // neither the parser nor `selectorText` reports. The rules stay small enough that no
  // selector mix reaches the limit, and the build confirms it by matching.
  const list = groups.flatMap(group => group.split(','));
  for (const group of groups) assert.ok(group.split(',').length <= 1000, 'a rule may not group more than 1000 selectors');
  assert.ok(rules.length >= Math.ceil(list.length / 1000));
  // An at-rule, a comment or a stray semicolon would each mean a rule the parser ends early.
  for (const token of ['@', '/*', ';']) assert.equal(body.includes(token), false, `the selector lists must not contain ${token}`);
  assert.ok(list.length > 12000);
  for (const selector of list) {
    assert.equal(selector, selector.trim());
    assert.ok(selector.length > 0);
    // Unbalanced brackets or quotes would swallow the selectors that follow, so the rule
    // would parse as something narrower than it reads.
    for (const [open, close] of [['(', ')'], ['[', ']']]) {
      assert.equal(selector.split(open).length, selector.split(close).length, `unbalanced ${open}${close} in ${selector}`);
    }
    for (const quote of ['"', "'"]) assert.equal((selector.split(quote).length - 1) % 2, 0, `unbalanced ${quote} in ${selector}`);
  }
});

test('cosmetic rules resolve by host suffix with exceptions subtracted', () => {
  const context = { domainRules, chrome: {}, console, URL };
  vm.runInNewContext(loadModule(), context);
  // The arrays come back from inside the VM context, so they are compared by value.
  const resolve = site => Array.from(context.api.resolveCosmetic(domainRules, site));
  assert.deepEqual(resolve('example.com'), ['.parent-ad']);
  // A subdomain inherits the parent's rules, however deep, and adds its own.
  assert.deepEqual(resolve('news.example.com'), ['.child-ad']);
  assert.deepEqual(resolve('a.b.news.example.com'), ['.child-ad']);
  // The walk is by label, so a host that merely ends in the same characters is not a match.
  assert.deepEqual(resolve('notexample.com'), []);
  assert.deepEqual(resolve('nothing-matches-this.invalid'), []);
  assert.deepEqual(resolve(''), []);
  // An exception on a subdomain cancels a selector the parent domain carries.
  assert.equal(resolve('news.example.com').includes('.parent-ad'), false);
  assert.equal(resolve('other.example.com').includes('.parent-ad'), true);
  // A `~` host drops that one value on that one host, and nothing else.
  assert.deepEqual(resolve('keep.example.com'), ['.parent-ad', '.narrowed']);
  assert.deepEqual(resolve('skip.example.com'), ['.parent-ad']);
  assert.deepEqual(resolve('other.example.com'), ['.parent-ad']);
});

test('the shipped host map is a lookup table of plain selectors', () => {
  const module = fs.readFileSync(path.join(root, 'content/ad-blocker-domain-rules.js'), 'utf8');
  const exported = name => JSON.parse(module.match(new RegExp(`^export const ${name} = (.*);$`, 'm'))[1]);
  const rules = Object.fromEntries(['hides', 'exceptions', 'globalExceptions'].map(name => [name, exported(name)]));
  const keys = [...Object.keys(rules.hides), ...Object.keys(rules.exceptions)];
  assert.ok(keys.length > 5000);
  // A lowercased hostname is looked up directly, so an uppercase key could never match.
  assert.deepEqual(keys.filter(key => key !== key.toLowerCase()), []);
  const values = [...Object.values(rules.hides), ...Object.values(rules.exceptions)].flat();
  assert.ok(values.length > 10000);
  assert.ok(values.every(value => typeof value === 'string'
    || (Array.isArray(value) && value.length > 1 && value.every(part => typeof part === 'string'))));
  assert.ok(Array.isArray(rules.globalExceptions));

  const context = { domainRules: rules, chrome: {}, console, URL };
  vm.runInNewContext(loadModule(), context);
  const resolve = site => Array.from(context.api.resolveCosmetic(rules, site));
  // The walk has to find the real data, not merely fail to crash on it.
  for (const host of Object.keys(rules.hides).filter((_, index) => index % 500 === 0)) {
    assert.ok(resolve(host).length > 0, `${host} resolves to nothing`);
  }
  // No host may resolve a selector it cancels. Only two of the shipped exceptions cancel
  // a domain-scoped hide; the rest cancel a generic selector, which the content script
  // subtracts from content/ad-blocker-excepted.js instead.
  const selectorOf = value => Array.isArray(value) ? value[0] : value;
  for (const [host, cancels] of Object.entries(rules.exceptions)) {
    const resolved = resolve(host);
    for (const value of cancels) assert.equal(resolved.includes(selectorOf(value)), false, `${host} must not resolve ${selectorOf(value)}`);
  }
});

// The content script's whole job: keep an excepted generic selector unless one of its
// exception rules names this host, add the selectors the service worker resolved, and
// adopt one stylesheet. Run against a stub realm with no `CSS`, so a script that reached
// for `CSS.supports()` again would throw rather than quietly cost a frame 4 ms.
const runContentScript = async ({ host, enabled = true, sites = [], cosmetic = [], excepted = [] }) => {
  const source = fs.readFileSync(path.join(root, 'content/ad-blocker.js'), 'utf8');
  const changed = [];
  const context = {
    console,
    location: { hostname: host },
    document: { adoptedStyleSheets: [] },
    CSSStyleSheet: class { replaceSync(text) { this.text = text; } },
    adBlockerExcepted: excepted,
    chrome: {
      runtime: { sendMessage: async () => ({ ok: true, topSite: host, enabled, sites, cosmetic }) },
      storage: { onChanged: { addListener(fn) { changed.push(fn); } } }
    }
  };
  vm.runInNewContext(source, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  const selectors = () => {
    const sheets = context.document.adoptedStyleSheets;
    if (!sheets.length) return [];
    assert.equal(sheets.length, 1, 'the frame adopts one stylesheet');
    const [, text, rest] = sheets[0].text.match(/^(.*)\{display:none!important\}$/) || [];
    assert.ok(text && !rest, `unexpected sheet text: ${sheets[0].text}`);
    return text.split(',');
  };
  return {
    selectors,
    async change(values) {
      changed.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'local'));
      await settle();
      return selectors();
    }
  };
};

test('the frame assembles one sheet from the excepted list and the resolved selectors', async () => {
  // `.generic-b` is both an excepted generic selector and a selector this host scopes, so
  // it arrives twice and an exception on it has to cancel both copies.
  const excepted = [
    { s: '.generic-a', d: ['cancels.example'] },
    { s: '.generic-b', d: ['other.example'] },
    { s: '.generic-c', d: ['~keep.example'] }
  ];
  const cosmetic = ['.host-ad', '.generic-b'];
  const run = options => runContentScript({ excepted, cosmetic, ...options });

  // `.generic-c` is cancelled by a `~keep.example` exception, which applies to every host
  // but that one, so it is absent everywhere below except on keep.example itself.
  const plain = await run({ host: 'nothing-matches-this.invalid' });
  assert.deepEqual(plain.selectors(), ['.generic-a', '.generic-b', '.host-ad']);
  // An exception reaches a subdomain of the host it names, and cancels the scoped copy too.
  assert.deepEqual((await run({ host: 'www.other.example' })).selectors(), ['.generic-a', '.host-ad']);
  assert.deepEqual((await run({ host: 'cancels.example' })).selectors(), ['.generic-b', '.host-ad']);
  assert.deepEqual((await run({ host: 'keep.example' })).selectors(), ['.generic-a', '.generic-b', '.generic-c', '.host-ad']);
  // Paused and disabled, the service worker resolves nothing and the frame adopts nothing.
  assert.deepEqual((await run({ host: 'paused.example', sites: ['paused.example'], cosmetic: [] })).selectors(), []);
  assert.deepEqual((await run({ host: 'off.example', enabled: false, cosmetic: [] })).selectors(), []);

  // A setting change swaps the sheet rather than recomputing anything: pausing drops it
  // at once, and resuming asks the service worker for the host's selectors again.
  const live = await run({ host: 'live.example' });
  assert.deepEqual(live.selectors(), ['.generic-a', '.generic-b', '.host-ad']);
  assert.deepEqual(await live.change({ adBlockerPausedSites: ['live.example'] }), []);
  assert.deepEqual(await live.change({ adBlockerPausedSites: [] }), ['.generic-a', '.generic-b', '.host-ad']);
  assert.deepEqual(await live.change({ 'moduleEnabled:ad-blocker': false }), []);
  assert.deepEqual(await live.change({ 'moduleEnabled:ad-blocker': true }), ['.generic-a', '.generic-b', '.host-ad']);
});

test('the shipped excepted list is generic selectors with the hosts that cancel them', () => {
  const excepted = JSON.parse(fs.readFileSync(path.join(root, 'content/ad-blocker-excepted.js'), 'utf8')
    .match(/^globalThis\.adBlockerExcepted = (.*);$/m)[1]);
  assert.ok(excepted.length > 200 && excepted.length < 500);
  assert.ok(excepted.every(entry => typeof entry.s === 'string' && entry.s
    && Array.isArray(entry.d) && entry.d.length && entry.d.every(domain => typeof domain === 'string' && domain === domain.toLowerCase())));
  const generic = fs.readFileSync(path.join(root, 'content/ad-blocker-generic.css'), 'utf8');
  const genericSelectors = [...generic.matchAll(/^(.*)\{display:none!important\}$/gm)].flatMap(match => match[1].split(','));
  assert.ok(genericSelectors.length > 12000);
  // The generic stylesheet is static and injected whole, so no selector any host cancels
  // may be in it; those are exactly the ones the frame assembles instead.
  const cancelled = new Set(excepted.map(entry => entry.s));
  assert.deepEqual(genericSelectors.filter(selector => cancelled.has(selector)), []);

  // Cookie and consent banners are left to the cookie-accepter module, which clicks
  // through them; a hidden banner is one the visitor can never dismiss. The exclusion
  // used to run in every frame and now runs once, at build time, over every artifact.
  const consent = /(?:cookie|consent|privacy|onetrust|didomi|usercentrics|quantcast|\bcmp\b)/i;
  const hides = JSON.parse(fs.readFileSync(path.join(root, 'content/ad-blocker-domain-rules.js'), 'utf8')
    .match(/^export const hides = (.*);$/m)[1]);
  const shipped = [
    ...genericSelectors,
    ...excepted.map(entry => entry.s),
    ...Object.values(hides).flat().map(value => Array.isArray(value) ? value[0] : value)
  ];
  assert.deepEqual(shipped.filter(selector => consent.test(selector)), []);
});

test('background serializes global and site changes and keeps DNR state aligned', async () => {
  let enabled = new Set(['easylist_ads']);
  let dynamic = [];
  // A registration left over from an earlier preference, which is what survives a browser
  // restart and an extension update: the module is on below, so this one is wrong and has
  // to be replaced rather than counted as already correct.
  let registered = [{ id: 'ad-blocker-generic', css: ['content/ad-blocker-generic.css'], matches: ['<all_urls>'], excludeMatches: ['*://stale.example/*'], allFrames: true, runAt: 'document_start', persistAcrossSessions: true, world: 'ISOLATED' }];
  const storage = {};
  const listeners = {};
  const chrome = {
    scripting: {
      async getRegisteredContentScripts() { return registered.map(script => ({ ...script })); },
      async registerContentScripts(scripts) {
        for (const script of scripts) {
          if (registered.some(existing => existing.id === script.id)) throw new Error(`Duplicate script ID ${script.id}`);
          // Chrome fills in its own defaults, so the stub does too: a reconcile that
          // compared them literally would unregister and register on every wake.
          registered.push({ persistAcrossSessions: true, world: 'ISOLATED', ...script });
        }
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) if (!registered.some(script => script.id === id)) throw new Error(`Nonexistent script ID ${id}`);
        registered = registered.filter(script => !ids.includes(script.id));
      }
    },
    runtime: { onInstalled: { addListener(fn) { listeners.installed = fn; } }, onStartup: { addListener(fn) { listeners.startup = fn; } }, onMessage: { addListener(fn) { listeners.message = fn; } } },
    storage: { local: { async get() { return { ...storage }; }, async set(values) { Object.assign(storage, values); listeners.changed?.(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'local'); } }, onChanged: { addListener(fn) { listeners.changed = fn; } } },
    declarativeNetRequest: {
      async getEnabledRulesets() { return [...enabled]; },
      async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) { disableRulesetIds.forEach(id => enabled.delete(id)); enableRulesetIds.forEach(id => enabled.add(id)); },
      async getDynamicRules() { return dynamic; },
      async updateDynamicRules({ removeRuleIds, addRules }) { dynamic = dynamic.filter(rule => !removeRuleIds.includes(rule.id)).concat(addRules); }
    }
  };
  const context = { domainRules, chrome, console: { error() {}, warn() {} }, URL };
  vm.runInNewContext(loadModule(), context);
  context.api.initializeAdBlocker();
  const message = request => new Promise(resolve => listeners.message(request, { tab: { url: 'https://news.example/story' } }, resolve));
  const scriptIds = () => registered.map(script => script.id).sort();
  const generic = () => registered.find(script => script.id === 'ad-blocker-generic');
  // The first reconcile replaced the stale registration rather than leaving it in place.
  await message({ type: 'ad-blocker:get' });
  assert.deepEqual(scriptIds(), ['ad-blocker-cosmetic', 'ad-blocker-generic']);
  assert.equal(generic().excludeMatches, undefined);
  const pause = await message({ type: 'ad-blocker:set-sites', sites: ['https://news.example/story', 'NEWS.EXAMPLE', ''] });
  assert.equal(pause.ok, true);
  assert.deepEqual(Array.from(pause.sites), ['news.example']);
  assert.equal(dynamic.length, 2);
  assert.equal(dynamic[0].action.type, 'allow');
  assert.equal(dynamic[1].action.type, 'allowAllRequests');
  assert.deepEqual(Array.from(generic().excludeMatches), ['*://news.example/*', '*://*.news.example/*']);
  const off = await message({ type: 'ad-blocker:set-enabled', enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(storage['moduleEnabled:ad-blocker'], false);
  // Disabled, the generic stylesheet goes away, because a frame cannot detach it itself.
  // The per-host script stays, which is what lets an open frame drop and restore its sheet.
  assert.deepEqual(scriptIds(), ['ad-blocker-cosmetic']);
  const on = await message({ type: 'ad-blocker:set-enabled', enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.extraEnabled, true);
  assert.deepEqual(scriptIds(), ['ad-blocker-cosmetic', 'ad-blocker-generic']);
  assert.deepEqual(Array.from(generic().excludeMatches), ['*://news.example/*', '*://*.news.example/*']);
  // A reconcile over a registration that is already right must not churn it, or every
  // worker wake would unregister and re-register in every tab's way.
  const before = JSON.stringify(registered);
  assert.equal((await message({ type: 'ad-blocker:reconcile' })).ok, true);
  assert.equal(JSON.stringify(registered), before);
  assert.equal((await message({ type: 'ad-blocker:get' })).topSite, 'news.example');
  // Paused, so the host map is not consulted at all and the frame is handed nothing.
  assert.deepEqual(Array.from((await message({ type: 'ad-blocker:get' })).cosmetic), []);
  storage['moduleEnabled:ad-blocker'] = false;
  listeners.installed();
  assert.equal((await message({ type: 'ad-blocker:get' })).enabled, false);
  storage['moduleEnabled:ad-blocker'] = true;
  listeners.startup();
  assert.equal((await message({ type: 'ad-blocker:get' })).enabled, true);
  const originalSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  const failedPause = await message({ type: 'ad-blocker:set-sites', sites: ['other.example'] });
  assert.equal(failedPause.ok, false);
  assert.equal(dynamic[0].condition.initiatorDomains[0], 'news.example');
  const failedToggle = await message({ type: 'ad-blocker:set-enabled', enabled: false });
  assert.equal(failedToggle.ok, false);
  assert.equal(enabled.has('easylist_ads'), true);
  chrome.storage.local.set = originalSet;
  const originalUpdate = chrome.declarativeNetRequest.updateEnabledRulesets;
  await originalUpdate({ disableRulesetIds: supplementalResources.map(resource => resource.id) });
  chrome.declarativeNetRequest.updateEnabledRulesets = async options => {
    if (options.enableRulesetIds?.includes('easylist_ads_extra')) throw new Error('Static quota reached');
    return originalUpdate(options);
  };
  const fallback = await message({ type: 'ad-blocker:reconcile' });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.enabled, true);
  assert.equal(fallback.extraEnabled, false);
  // One supplemental set over quota must not keep the other out.
  assert.equal(enabled.has('easylist_ads_extra_2'), true);
  chrome.declarativeNetRequest.updateEnabledRulesets = originalUpdate;
  assert.equal((await message({ type: 'ad-blocker:set-sites', sites: [] })).ok, true);
  // Resumed, the response carries the selectors the sender's own host scopes.
  assert.deepEqual(Array.from((await message({ type: 'ad-blocker:get' })).cosmetic), ['.news-ad']);
  storage['moduleEnabled:ad-blocker'] = false;
  await message({ type: 'ad-blocker:set-enabled', enabled: false });
  assert.deepEqual(Array.from((await message({ type: 'ad-blocker:get' })).cosmetic), []);
  assert.throws(() => context.api.cleanPausedSites(['bad host']), /Invalid site/);
  assert.throws(() => context.api.cleanPausedSites(['foo.-bad.example']), /Invalid site/);
});
