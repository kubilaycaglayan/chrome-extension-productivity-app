// The domain-scoped cosmetic corpus, precomputed by tools/ad-blocker-build/cosmetic.mjs.
// A service worker may not `import()` at runtime, so the map is pulled in with the module
// and parsed once per wake; a frame never sees it.
import { hides, exceptions, globalExceptions } from '../content/ad-blocker-domain-rules.js';
const domainRules = { hides, exceptions, globalExceptions };

const RULESET = 'easylist_ads';
const EXTRA_RULESETS = [
  'easylist_ads_extra', 'easylist_ads_extra_2', 'easylist_ads_extra_3',
  'easylist_ads_extra_4', 'easylist_ads_extra_5', 'easylist_ads_extra_6'
];
const ENABLED_KEY = 'moduleEnabled:ad-blocker';
const SITES_KEY = 'adBlockerPausedSites';
const RULE_ID_START = 1000000;
const RULE_PRIORITY = 1000000;
const COSMETIC_SCRIPT_ID = 'ad-blocker-cosmetic';
const GENERIC_CSS_ID = 'ad-blocker-generic';
const SHIM_SCRIPT_ID = 'ad-blocker-shims';
const COSMETIC_IDS = [COSMETIC_SCRIPT_ID, GENERIC_CSS_ID, SHIM_SCRIPT_ID];
// The hosts content/ad-blocker-shims.js carries a placeholder for. The shim has to stand in
// the page's own world and run before the page's first statement, which rules out reading a
// shared table at injection time, so the list it is matched on is repeated here and the
// tests hold the two sides together.
const SHIM_HOSTS = ['mackolik.com'];
let queue = Promise.resolve();

export function cleanPausedSites(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Enter up to 200 sites.');
  return [...new Set(value.filter(site => typeof site !== 'string' || site.trim()).map(site => {
    if (typeof site !== 'string') throw new Error('Invalid site.');
    const trimmed = site.trim().toLowerCase();
    let hostname = trimmed;
    if (/^https?:\/\//.test(trimmed)) {
      try { hostname = new URL(trimmed).hostname; } catch { throw new Error(`Invalid site: ${site}`); }
    }
    hostname = hostname.replace(/\.$/, '');
    if (!hostname || hostname.length > 253 || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error(`Invalid site: ${site}`);
    return hostname;
  }))].sort();
}

const matchesSite = (site, domain) => site === domain || site.endsWith(`.${domain}`);
// A value in the index is a selector, or [selector, ...hosts the rule excludes]. A `~`
// host narrows a rule rather than placing it, so it drops that one value on that one
// host; the shipped list has none, but the build format still permits them.
const selectorOf = value => Array.isArray(value) ? value[0] : value;
const inScope = (value, site) => !Array.isArray(value) || !value.slice(1).some(domain => matchesSite(site, domain));

// The selectors a host hides beyond the generic stylesheet, found by walking the host's
// label suffixes: a.b.example.com costs four lookups rather than a pass over the corpus.
// Exceptions are resolved the same way and subtracted, so a host that cancels a rule its
// parent domain carries ends up without it.
export function resolveCosmetic(rules, site) {
  if (!site) return [];
  const keys = site.split('.').map((_, position, labels) => labels.slice(position).join('.'));
  const scoped = index => keys.flatMap(key => index[key] || []).filter(value => inScope(value, site)).map(selectorOf);
  const cancelled = new Set([
    ...scoped(rules.exceptions),
    // An exception scoped only by `~` hosts applies everywhere but there, which no host
    // key can express, so it is carried as a list and evaluated against the host.
    ...rules.globalExceptions.filter(value => inScope(value, site)).map(selectorOf)
  ]);
  return [...new Set(scoped(rules.hides))].filter(selector => !cancelled.has(selector));
}

// The two halves of the cosmetic layer are registered apart because only one of them can
// be switched off from inside a frame. The content script owns the per-host sheet, so it
// stays registered even while the module is off: a frame already open adopts the sheet
// again the moment the setting comes back. Content-script CSS has no such handle, as a
// frame cannot detach what Chrome injected for it, so the generic stylesheet is instead
// registered only while the module is on and excluded on paused hosts. Registering it
// rather than declaring it in the manifest is also what honors the pause list at all, and
// what puts generic hiding in front of first paint.
const siteMatches = site => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(site)
  ? [`*://${site}/*`]
  : [`*://${site}/*`, `*://*.${site}/*`];

export function cosmeticScripts(enabled, sites) {
  const scripts = [{
    id: COSMETIC_SCRIPT_ID,
    js: ['content/ad-blocker-excepted.js', 'content/ad-blocker.js'],
    matches: ['<all_urls>'],
    allFrames: true,
    runAt: 'document_start'
  }];
  if (!enabled) return scripts;
  return [...scripts, {
    id: GENERIC_CSS_ID,
    css: ['content/ad-blocker-generic.css'],
    matches: ['<all_urls>'],
    // A hostname covers its subdomains here the way `matchesSite` covers them elsewhere.
    // An IP literal gets no subdomain pattern: it has no subdomains to cover, and a
    // match pattern is not the place to find out whether Chrome agrees.
    ...(sites.length ? { excludeMatches: sites.flatMap(siteMatches) } : {}),
    allFrames: true,
    runAt: 'document_start'
  }, {
    // Blocking a library the page then dereferences breaks the page's own code, so the
    // placeholders are registered on the same terms as the hiding they repair: only while
    // the module is on, never on a paused host, and ahead of the script that reads them.
    id: SHIM_SCRIPT_ID,
    js: ['content/ad-blocker-shims.js'],
    matches: SHIM_HOSTS.flatMap(siteMatches),
    ...(sites.length ? { excludeMatches: sites.flatMap(siteMatches) } : {}),
    // A placeholder is only worth anything to the page's own scripts, which never see the
    // isolated world.
    world: 'MAIN',
    allFrames: true,
    runAt: 'document_start'
  }];
}

// Chrome echoes a registration back with its own defaults filled in, so only the fields
// this module sets are compared.
const scriptShape = script => JSON.stringify([
  script.id, script.js || [], script.css || [], script.matches || [],
  script.excludeMatches || [], script.allFrames === true, script.runAt, script.world || 'ISOLATED'
]);

// A registration persists across browser sessions and survives an extension update, so the
// set that is already there is read back rather than assumed, and one left behind by an
// earlier preference is replaced. `updateContentScripts` would do for a registration that
// only changed shape, but not for one that has to appear or go away, so both cases take the
// same unregister-then-register path.
async function reconcileCosmetic(enabled, sites) {
  const desired = cosmeticScripts(enabled, sites);
  const wanted = new Map(desired.map(script => [script.id, scriptShape(script)]));
  const existing = (await chrome.scripting.getRegisteredContentScripts()).filter(script => COSMETIC_IDS.includes(script.id));
  const keep = new Set(existing.filter(script => scriptShape(script) === wanted.get(script.id)).map(script => script.id));
  const stale = existing.filter(script => !keep.has(script.id)).map(script => script.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const missing = desired.filter(script => !keep.has(script.id));
  if (missing.length) await chrome.scripting.registerContentScripts(missing);
  return desired.some(script => script.id === GENERIC_CSS_ID);
}

function enqueue(task) {
  const next = queue.then(task);
  queue = next.catch(error => console.error('Ad blocker:', error));
  return next;
}

function siteRules(sites) {
  return sites.flatMap((site, index) => [
    { id: RULE_ID_START + index * 2, priority: RULE_PRIORITY, action: { type: 'allow' }, condition: { initiatorDomains: [site] } },
    { id: RULE_ID_START + index * 2 + 1, priority: RULE_PRIORITY, action: { type: 'allowAllRequests' }, condition: { requestDomains: [site], resourceTypes: ['main_frame', 'sub_frame'] } }
  ]);
}

async function readState() {
  const stored = await chrome.storage.local.get([ENABLED_KEY, SITES_KEY]);
  const sets = await chrome.declarativeNetRequest.getEnabledRulesets();
  return { enabled: sets.includes(RULESET), extraEnabled: EXTRA_RULESETS.every(id => sets.includes(id)), sites: cleanPausedSites(stored[SITES_KEY] || []) };
}

async function reconcile() {
  const stored = await chrome.storage.local.get([ENABLED_KEY, SITES_KEY]);
  const enabled = stored[ENABLED_KEY] !== false;
  const sites = cleanPausedSites(stored[SITES_KEY] || []);
  await reconcileCosmetic(enabled, sites);
  const activeSets = await chrome.declarativeNetRequest.getEnabledRulesets();
  if (enabled && !activeSets.includes(RULESET)) await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [RULESET] });
  if (!enabled) {
    const disableRulesetIds = [RULESET, ...EXTRA_RULESETS].filter(id => activeSets.includes(id));
    if (disableRulesetIds.length) await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds });
  } else {
    // Each supplemental set is requested on its own, so one that does not fit the
    // shared static rule quota does not keep the others out.
    for (const id of EXTRA_RULESETS.filter(id => !activeSets.includes(id))) {
      try { await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] }); }
      catch (error) { console.warn('Supplemental ad rules unavailable:', id, error); }
    }
  }
  const existing = (await chrome.declarativeNetRequest.getDynamicRules()).filter(rule => rule.id >= RULE_ID_START && rule.id < RULE_ID_START + 400);
  const desired = siteRules(sites);
  if (JSON.stringify(existing) !== JSON.stringify(desired)) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(rule => rule.id), addRules: desired });
  }
  return readState();
}

export function initializeAdBlocker() {
  chrome.runtime.onInstalled.addListener(() => { void enqueue(reconcile); });
  chrome.runtime.onStartup.addListener(() => { void enqueue(reconcile); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[ENABLED_KEY] || changes[SITES_KEY])) void enqueue(reconcile);
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !['ad-blocker:get', 'ad-blocker:set-enabled', 'ad-blocker:set-sites', 'ad-blocker:validate-sites', 'ad-blocker:reconcile'].includes(message.type)) return;
    void enqueue(async () => {
      if (message.type === 'ad-blocker:validate-sites') return { sites: cleanPausedSites(message.sites) };
      if (message.type === 'ad-blocker:set-enabled') {
        if (typeof message.enabled !== 'boolean') throw new Error('Invalid setting.');
        const before = await chrome.declarativeNetRequest.getEnabledRulesets();
        await chrome.declarativeNetRequest.updateEnabledRulesets(message.enabled ? { enableRulesetIds: [RULESET] } : { disableRulesetIds: [RULESET, ...EXTRA_RULESETS] });
        try { await chrome.storage.local.set({ [ENABLED_KEY]: message.enabled }); }
        catch (error) {
          const after = await chrome.declarativeNetRequest.getEnabledRulesets();
          await chrome.declarativeNetRequest.updateEnabledRulesets({
            enableRulesetIds: before.filter(id => !after.includes(id)),
            disableRulesetIds: after.filter(id => !before.includes(id))
          });
          throw error;
        }
      }
      if (message.type === 'ad-blocker:set-sites') {
        const sites = cleanPausedSites(message.sites);
        const existing = (await chrome.declarativeNetRequest.getDynamicRules()).filter(rule => rule.id >= RULE_ID_START && rule.id < RULE_ID_START + 400);
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(rule => rule.id), addRules: siteRules(sites) });
        try { await chrome.storage.local.set({ [SITES_KEY]: sites }); }
        catch (error) {
          await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: siteRules(sites).map(rule => rule.id), addRules: existing });
          throw error;
        }
      }
      const state = message.type === 'ad-blocker:get' ? await readState() : await reconcile();
      // The frame asking may be a subframe, so the host that decides which rules apply is
      // the tab's, which only the sender knows.
      const topSite = (() => { try { return new URL(_sender.tab?.url || '').hostname.toLowerCase(); } catch { return ''; } })();
      const inactive = !state.enabled || state.sites.some(site => matchesSite(topSite, site));
      return { ...state, topSite, cosmetic: inactive ? [] : resolveCosmetic(domainRules, topSite) };
    }).then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  });
  void enqueue(reconcile);
}
