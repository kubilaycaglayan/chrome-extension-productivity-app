const RULESET = 'easylist_ads';
const EXTRA_RULESETS = ['easylist_ads_extra', 'easylist_ads_extra_2'];
const ENABLED_KEY = 'moduleEnabled:ad-blocker';
const SITES_KEY = 'adBlockerPausedSites';
const RULE_ID_START = 1000000;
const RULE_PRIORITY = 1000000;
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
      return { ...(message.type === 'ad-blocker:get' ? await readState() : await reconcile()), topSite: (() => { try { return new URL(_sender.tab?.url || '').hostname.toLowerCase(); } catch { return ''; } })() };
    }).then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  });
  void enqueue(reconcile);
}
