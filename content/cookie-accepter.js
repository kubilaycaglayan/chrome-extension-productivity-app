(() => {
  const settings = globalThis.cookieAccepterSettings;
  const phrases = new Set([
    "accept all", "accept all cookies", "allow all", "allow all cookies",
    "agree to all", "agree and close", "i agree",
    "tout accepter", "accepter tout", "alle akzeptieren", "alle zulassen",
    "alles akzeptieren", "aceptar todo", "aceptar todas", "accetta tutti",
    "accetta tutto", "hepsini kabul et", "tümünü kabul et", "alles accepteren",
    "aceitar todos", "aceitar tudo"
  ]);
  const adapters = [
    { name: "OneTrust", dialog: "#onetrust-banner-sdk", action: "#onetrust-accept-btn-handler", opener: "#onetrust-pc-btn-handler" },
    { name: "OneTrust preferences", dialog: "#onetrust-pc-sdk", action: "#accept-recommended-btn-handler", needsOpenedPreferences: true },
    { name: "Cookiebot", dialog: "#CybotCookiebotDialog", action: "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept" },
    { name: "Didomi", dialog: "#didomi-host .didomi-notice-banner, #didomi-host .didomi-popup-notice", action: "#didomi-notice-agree-button" },
    { name: "Usercentrics", dialog: "#uc-center-container, #uc-banner-modal, #uc-central-banner-modal", action: "[data-testid='uc-accept-all-button'], #uc-btn-accept-banner, [data-testid='uc-accept-all-button-banner']" },
    { name: "Quantcast", dialog: "#qc-cmp2-container", action: ".qc-cmp2-summary-buttons button", checkText: true }
  ];
  // The bespoke-banner fallback only ever considers real controls, never bare links: an <a> that
  // reads "Accept all" is as likely to be a policy page as a consent decision.
  const genericControls = "button, [role='button'], input[type='button'], input[type='submit'], a[role='button']";
  const consentWords = /cookie|consent|privacy|gdpr|ccpa|çerez|kvkk|datenschutz|einwilligung|rgpd|personal data|personenbezogene|dados pessoais|persoonsgegevens|dati personali|datos personales|kişisel veri/i;
  // A banner that fades in through a CSS transition mutates no attribute, so the observer never
  // fires again for it. A bounded poll reconsiders the page while a recognized dialog is up.
  const pollInterval = 500;
  const pollGrace = 15000;
  const pollCeiling = 30000;
  const genericControlBudget = 1500;

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
  let pollTimer;
  let domReadyListener;
  let lastUrl = location.href;
  const observedRoots = new Set();
  let attempted = new WeakMap();
  let handledDialogs = new WeakSet();
  let openedPreferences = false;
  let cachedRoots = [document];
  let rootsDirty = true;
  let adapterActed = false;
  let genericActed = false;
  let pageStarted = 0;
  let pollDeadline = 0;

  function visible(element, requireBox = true) {
    if (!element || !element.isConnected || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement || node.getRootNode()?.host) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    // Dialog wrappers are often zero-box parents of the real banner (Usercentrics' #uc-banner-modal
    // is one), so only the control that gets clicked has to occupy space.
    return !requireBox || element.getClientRects().length > 0;
  }

  function actionable(button) {
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" && visible(button);
  }

  // Turkish locales map "I" to "ı", so a label is matched against both the locale-aware and the
  // invariant lowercase form.
  function labels(element) {
    const text = (element.textContent || element.getAttribute("aria-label") || element.value || "").replace(/\s+/g, " ").trim();
    return [text.toLowerCase(), text.toLocaleLowerCase()];
  }

  function isAcceptAll(element) {
    return labels(element).some(text => phrases.has(text));
  }

  function roots() {
    if (!rootsDirty) return cachedRoots;
    const found = [document];
    for (let i = 0; i < found.length && found.length < 100; i++) {
      for (const element of found[i].querySelectorAll("*")) {
        if (element.shadowRoot) found.push(element.shadowRoot);
      }
    }
    rootsDirty = false;
    cachedRoots = found;
    return found;
  }

  function overlay(node) {
    if (node.tagName === "DIALOG" || node.getAttribute("aria-modal") === "true") return true;
    if (["dialog", "alertdialog"].includes(node.getAttribute("role"))) return true;
    const position = getComputedStyle(node).position;
    return position === "fixed" || position === "sticky";
  }

  // Sites that built their own banner get one narrow shape: an exact accept-all phrase on a real
  // control, inside a pinned overlay that is itself a block of consent prose. Looser rules start
  // clicking newsletter and paywall buttons, which the fixture suite guards against.
  function scanGeneric(rootList) {
    let examined = 0;
    for (const root of rootList) {
      for (const control of root.querySelectorAll(genericControls)) {
        if (++examined > genericControlBudget) return;
        if (attempted.has(control) || !isAcceptAll(control) || !actionable(control)) continue;
        for (let node = control.parentElement || control.getRootNode()?.host, depth = 0;
             node && node.nodeType === 1 && depth < 8;
             depth++, node = node.parentElement || node.getRootNode()?.host) {
          if (!overlay(node)) continue;
          const text = (node.textContent || "").replace(/\s+/g, " ").trim();
          if (text.length < 40 || text.length > 4000 || !consentWords.test(text)) continue;
          attempted.set(control, Date.now());
          genericActed = true;
          control.click();
          return;
        }
      }
    }
  }

  function scan() {
    if (!enabled || paused.includes(site)) return;
    const rootList = roots();
    let dialogPending = false;
    for (const root of rootList) {
      if (observer && !observedRoots.has(root)) {
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden", "disabled"] });
        observedRoots.add(root);
      }
      for (const adapter of adapters) {
        for (const dialog of root.querySelectorAll(adapter.dialog)) {
          if (handledDialogs.has(dialog)) continue;
          // A dialog that is present but not yet shown is the fade-in case: keep polling for it
          // rather than writing the page off after the last mutation.
          dialogPending = true;
          if (!visible(dialog, false)) continue;
          if (adapter.needsOpenedPreferences && !openedPreferences &&
              !(Date.now() <= pollDeadline && overlay(dialog))) continue;
          for (const button of dialog.querySelectorAll(adapter.action)) {
            if (!actionable(button)) continue;
            if (adapter.checkText && !isAcceptAll(button) &&
                !(adapter.name === "Quantcast" && labels(button).some(text => ["agree", "concordo", "aceitar"].includes(text)) && button.getAttribute("mode") === "primary")) continue;
            if (attempted.has(button)) continue;
            attempted.set(button, Date.now());
            handledDialogs.add(dialog);
            adapterActed = true;
            button.click();
            if (adapter.needsOpenedPreferences) openedPreferences = false;
            // One action per rendered control. A second banner instance, or a new one after
            // navigation, is picked up by the next poll or mutation.
            return;
          }
          if (adapter.opener) {
            const opener = dialog.querySelector(adapter.opener);
            if (actionable(opener) && !attempted.has(opener)) {
              attempted.set(opener, Date.now());
              openedPreferences = true;
              adapterActed = true;
              opener.click();
              return;
            }
          }
        }
      }
    }
    if (dialogPending) extendPolling();
    // A recognized CMP owns the page while its dialog is up; the fallback is for sites that ship
    // no CMP at all, acts at most once per page, and only inside the search window, so a long-lived
    // page does not pay for a label sweep on every later mutation.
    else if (!adapterActed && !genericActed && Date.now() <= pollDeadline) scanGeneric(rootList);
  }

  function extendPolling() {
    if (!enabled) return;
    pollDeadline = Math.min(Date.now() + pollGrace, pageStarted + pollCeiling);
    if (!pollTimer) pollTimer = setInterval(poll, pollInterval);
  }

  function poll() {
    if (!enabled || Date.now() > pollDeadline) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    // Polls are the only place the shadow-root walk is redone unprompted, which keeps roots
    // attached inside a late shadow tree discoverable without walking the DOM on every mutation.
    rootsDirty = true;
    scan();
  }

  function schedule() {
    if (timer || !enabled) return;
    timer = setTimeout(() => { timer = null; scan(); }, 100);
  }

  function navigated() {
    pageStarted = Date.now();
    adapterActed = false;
    genericActed = false;
    rootsDirty = true;
    extendPolling();
    schedule();
  }

  function stop() {
    observer?.disconnect();
    observer = undefined;
    observedRoots.clear();
    clearTimeout(timer);
    clearInterval(routeTimer);
    clearInterval(pollTimer);
    timer = null;
    routeTimer = null;
    pollTimer = null;
    if (domReadyListener) document.removeEventListener("DOMContentLoaded", domReadyListener);
    domReadyListener = null;
    attempted = new WeakMap();
    handledDialogs = new WeakSet();
    openedPreferences = false;
    adapterActed = false;
    genericActed = false;
    cachedRoots = [document];
    rootsDirty = true;
    pollDeadline = 0;
    removeEventListener("popstate", navigated);
    removeEventListener("hashchange", navigated);
  }

  function start() {
    if (enabled) return;
    enabled = true;
    pageStarted = Date.now();
    observer = new MutationObserver(records => {
      // Attribute-only churn cannot introduce a shadow root, so the walk is only redone when the
      // tree actually changed shape.
      for (const record of records) {
        if (record.addedNodes.length || record.removedNodes.length) { rootsDirty = true; break; }
      }
      schedule();
    });
    addEventListener("popstate", navigated);
    addEventListener("hashchange", navigated);
    routeTimer = setInterval(() => {
      if (lastUrl !== location.href) { lastUrl = location.href; navigated(); }
    }, 1500);
    extendPolling();
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
