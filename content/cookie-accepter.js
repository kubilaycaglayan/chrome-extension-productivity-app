(() => {
  const settings = globalThis.cookieAccepterSettings;
  const phrases = new Set([
    "accept all", "allow all", "agree to all", "agree and close", "i agree",
    "tout accepter", "accepter tout", "alle akzeptieren", "alle zulassen",
    "alles akzeptieren", "aceptar todo", "aceptar todas", "accetta tutti",
    "accetta tutto", "hepsini kabul et", "tümünü kabul et", "alles accepteren",
    "aceitar todos", "aceitar tudo"
  ]);
  const adapters = [
    { name: "OneTrust", dialog: "#onetrust-banner-sdk", action: "#onetrust-accept-btn-handler", opener: "#onetrust-pc-btn-handler" },
    { name: "OneTrust preferences", dialog: "#onetrust-pc-sdk", action: "#accept-recommended-btn-handler", needsOpenedPreferences: true },
    { name: "Cookiebot", dialog: "#CybotCookiebotDialog", action: "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" },
    { name: "Didomi", dialog: "#didomi-host .didomi-notice-banner, #didomi-host .didomi-popup-notice", action: "#didomi-notice-agree-button" },
    { name: "Usercentrics", dialog: "#uc-center-container, #uc-banner-modal", action: "[data-testid='uc-accept-all-button'], #uc-btn-accept-banner, [data-testid='uc-accept-all-button-banner']" },
    { name: "Quantcast", dialog: "#qc-cmp2-container", action: ".qc-cmp2-summary-buttons button", checkText: true }
  ];

  const hostname = () => {
    try {
      // The pause applies to the tab's site, including embedded CMP frames.
      const ancestors = location.ancestorOrigins;
      const origin = ancestors?.length ? ancestors[ancestors.length - 1] : location.href;
      const url = new URL(origin);
      return ["http:", "https:"].includes(url.protocol) ? settings.normalizeHost(url.hostname) : null;
    } catch { return null; }
  };
  const site = hostname();
  if (!site) return;

  let enabled = false;
  let paused = [];
  let observer;
  let timer;
  let routeTimer;
  let domReadyListener;
  let lastUrl = location.href;
  const observedRoots = new Set();
  let attempted = new WeakMap();
  let handledDialogs = new WeakSet();
  let openedPreferences = false;

  function visible(element) {
    if (!element || !element.isConnected || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement || node.getRootNode()?.host) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    return element.getClientRects().length > 0;
  }

  function actionable(button) {
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" && visible(button);
  }

  function roots() {
    const found = [document];
    for (let i = 0; i < found.length && found.length < 100; i++) {
      for (const element of found[i].querySelectorAll("*")) {
        if (element.shadowRoot) found.push(element.shadowRoot);
      }
    }
    return found;
  }

  function scan() {
    if (!enabled || paused.includes(site)) return;
    for (const root of roots()) {
      if (observer && !observedRoots.has(root)) {
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden", "disabled"] });
        observedRoots.add(root);
      }
      for (const adapter of adapters) {
        for (const dialog of root.querySelectorAll(adapter.dialog)) {
          if (handledDialogs.has(dialog) || !visible(dialog)) continue;
          if (adapter.needsOpenedPreferences && !openedPreferences) continue;
          for (const button of dialog.querySelectorAll(adapter.action)) {
            if (!actionable(button)) continue;
            const label = (button.textContent || button.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
            if (adapter.checkText && !phrases.has(label) && !(adapter.name === "Quantcast" && ["agree", "concordo", "aceitar"].includes(label) && button.getAttribute("mode") === "primary")) continue;
            if (attempted.has(button)) continue;
            attempted.set(button, Date.now());
            handledDialogs.add(dialog);
            button.click();
            if (adapter.needsOpenedPreferences) openedPreferences = false;
            // One action per rendered control. A new banner/control can be handled after navigation.
            return;
          }
          if (adapter.opener) {
            const opener = dialog.querySelector(adapter.opener);
            if (actionable(opener) && !attempted.has(opener)) {
              attempted.set(opener, Date.now());
              openedPreferences = true;
              opener.click();
              return;
            }
          }
        }
      }
    }
  }

  function schedule() {
    if (timer || !enabled) return;
    timer = setTimeout(() => { timer = null; scan(); }, 100);
  }

  function stop() {
    observer?.disconnect();
    observer = undefined;
    observedRoots.clear();
    clearTimeout(timer);
    clearInterval(routeTimer);
    timer = null;
    routeTimer = null;
    if (domReadyListener) document.removeEventListener("DOMContentLoaded", domReadyListener);
    domReadyListener = null;
    attempted = new WeakMap();
    handledDialogs = new WeakSet();
    openedPreferences = false;
    removeEventListener("popstate", schedule);
    removeEventListener("hashchange", schedule);
  }

  function start() {
    if (enabled) return;
    enabled = true;
    observer = new MutationObserver(schedule);
    addEventListener("popstate", schedule);
    addEventListener("hashchange", schedule);
    routeTimer = setInterval(() => {
      if (lastUrl !== location.href) { lastUrl = location.href; schedule(); }
    }, 1500);
    if (document.documentElement) scan();
    else {
      domReadyListener = () => { domReadyListener = null; scan(); };
      document.addEventListener("DOMContentLoaded", domReadyListener, { once: true });
    }
  }

  function apply(values) {
    paused = settings.cleanSites(values[settings.pausedKey]);
    if (values[settings.key] === true && !paused.includes(site)) start();
    else { enabled = false; stop(); }
  }

  let revision = 0;
  let currentValues = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes[settings.key] && !changes[settings.pausedKey])) return;
    const nextRevision = ++revision;
    if (changes[settings.key]?.newValue !== undefined && changes[settings.key].newValue !== true ||
        changes[settings.pausedKey] && settings.cleanSites(changes[settings.pausedKey].newValue).includes(site)) {
      enabled = false;
      stop();
    }
    if (currentValues) {
      for (const [key, change] of Object.entries(changes)) currentValues[key] = change.newValue;
      apply(currentValues);
      return;
    }
    chrome.storage.local.get([settings.key, settings.pausedKey]).then(values => {
      if (revision !== nextRevision) return;
      currentValues = values;
      apply(values);
    }).catch(() => { enabled = false; stop(); });
  });
  const initialRevision = revision;
  chrome.storage.local.get([settings.key, settings.pausedKey]).then(values => {
    if (revision === initialRevision) { currentValues = values; apply(values); }
  }).catch(() => {});
})();
