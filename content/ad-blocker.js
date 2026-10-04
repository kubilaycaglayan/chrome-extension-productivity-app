(() => {
  if (globalThis.__adBlockerInitialized) return;
  globalThis.__adBlockerInitialized = true;
  const key = 'moduleEnabled:ad-blocker';
  const sitesKey = 'adBlockerPausedSites';
  let topSite = location.hostname.toLowerCase();
  let enabled = false;
  let sites = [];
  let styles = [];

  const matches = (site, domain) => site === domain || site.endsWith(`.${domain}`);
  function applies(domains) {
    const positives = domains.filter(domain => !domain.startsWith('~'));
    return (!positives.length || positives.some(domain => matches(topSite, domain))) &&
      !domains.some(domain => domain.startsWith('~') && matches(topSite, domain.slice(1)));
  }
  function clear() { styles.forEach(style => style.remove()); styles = []; }
  function update() {
    clear();
    if (!enabled || sites.some(site => matches(topSite, site))) return;
    const entries = globalThis.adBlockerSelectors || [];
    const exceptions = new Set(entries.filter(entry => entry.exception && applies(entry.domains)).map(entry => entry.selector));
    const selectors = [...new Set(entries.filter(entry => !entry.exception && applies(entry.domains) && !exceptions.has(entry.selector)).map(entry => entry.selector))]
      .filter(selector => !/(?:cookie|consent|privacy|onetrust|didomi|usercentrics|quantcast|\bcmp\b)/i.test(selector))
      .filter(selector => CSS.supports(`selector(${selector})`));
    for (let index = 0; index < selectors.length; index += 250) {
      const style = document.createElement('style');
      style.textContent = `${selectors.slice(index, index + 250).join(',')} { display: none !important; }`;
      (document.head || document.documentElement).append(style);
      styles.push(style);
    }
  }
  chrome.runtime.sendMessage({ type: 'ad-blocker:get' }).then(result => {
    if (!result?.ok) return;
    topSite = result.topSite || topSite;
    enabled = result.enabled;
    sites = result.sites;
    update();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes[key] && !changes[sitesKey])) return;
    if (changes[key]) enabled = changes[key].newValue !== false;
    if (changes[sitesKey]) sites = Array.isArray(changes[sitesKey].newValue) ? changes[sitesKey].newValue : [];
    update();
  });
})();
