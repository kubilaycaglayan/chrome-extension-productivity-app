// Most settings default to enabled. Consent automation requires explicit opt-in.
globalThis.productivityModules = {
  register(id, start) {
    const key = `moduleEnabled:${id}`;
    let enabled = false;
    let cleanup;
    let revision = 0;
    const apply = (value) => {
      const next = id === "cookie-accepter" ? value === true : value !== false;
      if (next === enabled) return;
      enabled = next;
      if (enabled) cleanup = start();
      else {
        cleanup?.();
        cleanup = undefined;
      }
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[key]) {
        revision++;
        apply(changes[key].newValue);
      }
    });
    const initialRevision = revision;
    chrome.storage.local.get(key).then((result) => {
      if (revision === initialRevision) apply(result[key]);
    });
  }
};
