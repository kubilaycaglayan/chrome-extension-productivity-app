productivityModules.register("netflix-series-tags", () => {
  if (location.hostname !== "www.netflix.com") return;

  const STYLE_ID = "productivity-netflix-series-tags-style";
  const BADGE_ATTRIBUTE = "data-productivity-series-tag";
  const POSTER_ATTRIBUTE = "data-productivity-series-poster";
  const seriesIds = new Set();
  let active = true;
  let refreshQueued = false;

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${BADGE_ATTRIBUTE}] {
        position: absolute !important;
        z-index: 2147483000 !important;
        top: 6px !important;
        left: 6px !important;
        display: block !important;
        padding: 6px 9px !important;
        border: 2px solid #111 !important;
        border-radius: 4px !important;
        background: #ffe500 !important;
        color: #111 !important;
        box-shadow: 0 2px 8px #000c !important;
        font: 900 15px/1.1 Arial, sans-serif !important;
        letter-spacing: .07em !important;
        text-transform: uppercase !important;
        pointer-events: none !important;
      }
      [${POSTER_ATTRIBUTE}] {
        position: relative !important;
        overflow: visible !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function trackingId(node) {
    const tracking = node.getAttribute("data-ui-tracking-context");
    if (tracking) {
      try {
        const data = JSON.parse(decodeURIComponent(tracking));
        if (data.video_id != null) return String(data.video_id);
      } catch { /* Some Netflix versions store a non-JSON tracking value. */ }
    }
    const href = node.getAttribute("href");
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      const browseId = url.searchParams.get("jbv");
      if (browseId) return browseId;
    } catch { /* Ignore malformed links. */ }
    const match = href.match(/\/title\/(\d+)/);
    return match?.[1] || null;
  }

  function getCard(node) {
    return node.closest(
      ".title-card-container, .title-card, [data-uia='title-card'], [data-uia*='title-card'], .slider-item"
    ) || node.parentElement;
  }

  function getPoster(node) {
    const card = getCard(node);
    const linkSelector = "a[data-uia='standard-card'], a[href*='jbv='], a[href*='/title/']";
    const titleLink = node.closest(linkSelector) || card?.querySelector(linkSelector);
    if (titleLink) {
      const standardCardImage = titleLink.querySelector("img.standard-card");
      if (standardCardImage?.parentElement) return standardCardImage.parentElement;

      const image = titleLink.querySelector("img");
      if (image?.parentElement) return image.parentElement;
      return titleLink.querySelector(
        ".boxart-image-in-padded-container, .boxart-rounded, [data-uia*='boxart']"
      ) || titleLink;
    }
    return card?.querySelector(
      ".boxart-image-in-padded-container, .boxart-rounded, .boxart-container, [data-uia*='boxart']"
    ) || card;
  }

  function tagPoster(poster) {
    if (!poster || poster.querySelector(`[${BADGE_ATTRIBUTE}]`)) return;
    poster.setAttribute(POSTER_ATTRIBUTE, "");
    const badge = document.createElement("span");
    badge.setAttribute(BADGE_ATTRIBUTE, "");
    badge.textContent = "SERIES";
    badge.setAttribute("aria-label", "TV series");
    poster.appendChild(badge);
  }

  function scan() {
    if (!active || !seriesIds.size) return;
    for (const node of document.querySelectorAll(
      "[data-ui-tracking-context], a[data-uia='standard-card'], a[href*='jbv='], a[href*='/title/']"
    )) {
      const id = trackingId(node);
      if (id && seriesIds.has(id)) tagPoster(getPoster(node));
    }
  }

  function queueScan() {
    if (refreshQueued || !active) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      scan();
    });
  }

  function onMetadata(event) {
    for (const id of event.detail?.ids || []) seriesIds.add(String(id));
    queueScan();
  }

  function onStorage(changes, area) {
    if (area === "local" && changes["moduleEnabled:netflix-series-tags"]?.newValue !== true) {
      cleanup();
    }
  }

  function cleanup() {
    active = false;
    observer.disconnect();
    window.removeEventListener("productivity-netflix-series-metadata", onMetadata);
    window.removeEventListener("popstate", queueScan);
    chrome.storage.onChanged.removeListener(onStorage);
    document.querySelectorAll(`[${BADGE_ATTRIBUTE}]`).forEach(node => node.remove());
    document.querySelectorAll(`[${POSTER_ATTRIBUTE}]`).forEach(node => node.removeAttribute(POSTER_ATTRIBUTE));
    document.getElementById(STYLE_ID)?.remove();
  }

  const observer = new MutationObserver(queueScan);
  addStyles();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("productivity-netflix-series-metadata", onMetadata);
  window.addEventListener("popstate", queueScan);
  window.dispatchEvent(new Event("productivity-netflix-series-snapshot-request"));
  chrome.storage.onChanged.addListener(onStorage);
  queueScan();
  return cleanup;
});
