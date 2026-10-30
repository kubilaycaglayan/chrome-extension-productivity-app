// Netflix's catalog payloads contain typed title records (Show, Movie, Episode).
// Keep this tiny bridge in the page's world so the isolated content script can use
// that type information without guessing from a card's position or title text.
(() => {
  const seriesIds = new Set();
  const announce = () => window.dispatchEvent(new CustomEvent("productivity-netflix-series-metadata", {
    detail: { ids: [...seriesIds] }
  }));

  function collect(value) {
    const found = new Set();
    const seen = new WeakSet();
    const stack = [value];
    let visited = 0;
    while (stack.length && visited < 50000) {
      const item = stack.pop();
      if (!item || typeof item !== "object" || seen.has(item)) continue;
      seen.add(item);
      visited++;

      if (Array.isArray(item)) {
        for (const child of item) stack.push(child);
        continue;
      }

      const kind = String(item.__typename || item.videoType || "").toLowerCase();
      if (["show", "series", "episode", "tv_series", "tvshow"].includes(kind)) {
        const candidates = [item.videoId, item.unifiedEntityId, item.id];
        for (const candidate of candidates) {
          const match = String(candidate ?? "").match(/^(?:Video:)?(\d+)$/);
          if (match) {
            found.add(match[1]);
            break;
          }
        }
      }
      for (const child of Object.values(item)) stack.push(child);
    }

    let changed = false;
    for (const id of found) {
      if (!seriesIds.has(id)) {
        seriesIds.add(id);
        changed = true;
      }
    }
    if (changed) announce();
  }

  function relevant(url) {
    return /netflix\.com$/i.test(url.hostname) && /graphql|shakti/i.test(url.pathname);
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = originalFetch.apply(this, args);
    result.then(response => {
      try {
        const url = new URL(response.url || args[0]?.url || args[0], location.href);
        if (relevant(url) && response.ok) {
          response.clone().json().then(collect).catch(() => {});
        }
      } catch { /* Requests without a readable URL are irrelevant. */ }
    }).catch(() => {});
    return result;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__productivityNetflixUrl = String(url);
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = new URL(this.responseURL || this.__productivityNetflixUrl, location.href);
        if (!relevant(url) || this.status < 200 || this.status >= 300) return;
        const data = this.responseType === "json"
          ? this.response
          : JSON.parse(this.responseText);
        collect(data);
      } catch { /* Non-JSON responses and inaccessible response bodies are ignored. */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };

  window.addEventListener("productivity-netflix-series-snapshot-request", announce);
})();
