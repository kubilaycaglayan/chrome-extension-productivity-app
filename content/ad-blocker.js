(() => {
  if (globalThis.__adBlockerInitialized) return;
  globalThis.__adBlockerInitialized = true;
  const key = 'moduleEnabled:ad-blocker';
  const sitesKey = 'adBlockerPausedSites';
  // Everything a frame can be told in advance it is told: generic selectors no host
  // cancels are in content/ad-blocker-generic.css, and the selectors this host scopes
  // arrive resolved on the `ad-blocker:get` response. What is left here is the 275
  // generic rules that at least one host cancels, which is the one decision that needs
  // the host, plus the assembly of a single stylesheet.
  const excepted = globalThis.adBlockerExcepted || [];
  let topSite = location.hostname.toLowerCase();
  let enabled = false;
  let sites = [];
  let scoped = [];
  let sheet = null;

  const matches = (site, domain) => site === domain || site.endsWith(`.${domain}`);
  const inactive = () => !enabled || sites.some(site => matches(topSite, site));
  // A `~host` narrows a rule rather than placing it, so a rule applies wherever its plain
  // domains put it and nowhere a negated one names. The shipped list has no negated
  // domain; the format carries them, so this does too.
  function applies(domains) {
    const placed = domains.filter(domain => !domain.startsWith('~'));
    return (!placed.length || placed.some(domain => matches(topSite, domain))) &&
      !domains.some(domain => domain.startsWith('~') && matches(topSite, domain.slice(1)));
  }

  function detach() {
    if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(adopted => adopted !== sheet);
  }

  function update() {
    if (inactive()) { detach(); return; }
    const cancelled = new Set(excepted.filter(entry => applies(entry.d)).map(entry => entry.s));
    // An exception cancels its selector on this host whichever list offered it, so the
    // subtraction runs over the union rather than over the excepted list alone.
    const selectors = [...new Set([...excepted.map(entry => entry.s), ...scoped])].filter(selector => !cancelled.has(selector));
    if (!selectors.length) { detach(); return; }
    sheet ||= new CSSStyleSheet();
    sheet.replaceSync(`${selectors.join(',')}{display:none!important}`);
    if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }

  function request() {
    return chrome.runtime.sendMessage({ type: 'ad-blocker:get' }).then(result => {
      if (!result?.ok) return;
      topSite = result.topSite || topSite;
      enabled = result.enabled;
      sites = result.sites;
      scoped = result.cosmetic || [];
      update();
    }).catch(() => {});
  }

  void request();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes[key] && !changes[sitesKey])) return;
    if (changes[key]) enabled = changes[key].newValue !== false;
    if (changes[sitesKey]) sites = Array.isArray(changes[sitesKey].newValue) ? changes[sitesKey].newValue : [];
    // Going inactive is immediate, because the sheet is already here. Coming back needs
    // the host's own selectors again: the service worker hands out none while the module
    // is off or the host is paused, so there is nothing cached to put back.
    if (inactive()) update(); else void request();
  });
})();
