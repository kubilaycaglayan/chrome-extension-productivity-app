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
  const cosmetic = manifest.content_scripts.find(entry => entry.js.includes('content/ad-blocker.js'));
  assert.equal(cosmetic.all_frames, true);
});

test('background serializes global and site changes and keeps DNR state aligned', async () => {
  let enabled = new Set(['easylist_ads']);
  let dynamic = [];
  const storage = {};
  const listeners = {};
  const chrome = {
    runtime: { onInstalled: { addListener(fn) { listeners.installed = fn; } }, onStartup: { addListener(fn) { listeners.startup = fn; } }, onMessage: { addListener(fn) { listeners.message = fn; } } },
    storage: { local: { async get() { return { ...storage }; }, async set(values) { Object.assign(storage, values); listeners.changed?.(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'local'); } }, onChanged: { addListener(fn) { listeners.changed = fn; } } },
    declarativeNetRequest: {
      async getEnabledRulesets() { return [...enabled]; },
      async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) { disableRulesetIds.forEach(id => enabled.delete(id)); enableRulesetIds.forEach(id => enabled.add(id)); },
      async getDynamicRules() { return dynamic; },
      async updateDynamicRules({ removeRuleIds, addRules }) { dynamic = dynamic.filter(rule => !removeRuleIds.includes(rule.id)).concat(addRules); }
    }
  };
  const source = fs.readFileSync(path.join(root, 'modules/ad-blocker.js'), 'utf8').replace('export function ', 'function ').replace('export function ', 'function ') + '\nthis.api = { cleanPausedSites, initializeAdBlocker };';
  const context = { chrome, console: { error() {}, warn() {} }, URL };
  vm.runInNewContext(source, context);
  context.api.initializeAdBlocker();
  const message = request => new Promise(resolve => listeners.message(request, { tab: { url: 'https://news.example/story' } }, resolve));
  const pause = await message({ type: 'ad-blocker:set-sites', sites: ['https://news.example/story', 'NEWS.EXAMPLE', ''] });
  assert.equal(pause.ok, true);
  assert.deepEqual(Array.from(pause.sites), ['news.example']);
  assert.equal(dynamic.length, 2);
  assert.equal(dynamic[0].action.type, 'allow');
  assert.equal(dynamic[1].action.type, 'allowAllRequests');
  const off = await message({ type: 'ad-blocker:set-enabled', enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(storage['moduleEnabled:ad-blocker'], false);
  const on = await message({ type: 'ad-blocker:set-enabled', enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.extraEnabled, true);
  assert.equal((await message({ type: 'ad-blocker:get' })).topSite, 'news.example');
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
  assert.throws(() => context.api.cleanPausedSites(['bad host']), /Invalid site/);
  assert.throws(() => context.api.cleanPausedSites(['foo.-bad.example']), /Invalid site/);
});
