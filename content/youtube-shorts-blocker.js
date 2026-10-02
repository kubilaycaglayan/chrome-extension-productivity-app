productivityModules.register("youtube-shorts-blocker", () => {
  let active = true;
  const STYLE_ID = "productivity-youtube-shorts-blocker-style";
  const HIDDEN_ATTRIBUTE = "data-productivity-shorts-hidden";

  // These selectors target YouTube's Shorts-specific components and links. The
  // :has() selectors also catch recommendation cards whose Shorts link is
  // nested inside a renderer that YouTube changes frequently.
  const SHORTS_SELECTORS = [
    'a[href="/shorts"]',
    'a[href^="/shorts/"]',
    'a[href="https://www.youtube.com/shorts"]',
    'a[href^="https://www.youtube.com/shorts/"]',
    'ytd-shorts',
    'ytd-reel-shelf-renderer',
    'ytd-reel-item-renderer',
    'ytd-rich-shelf-renderer[is-shorts]',
    'ytd-rich-shelf-renderer:has(a[href="/shorts"])',
    'ytd-rich-shelf-renderer:has(a[href^="/shorts/"])',
    'ytd-rich-section-renderer:has(a[href="/shorts"])',
    'ytd-rich-section-renderer:has(a[href^="/shorts/"])',
    'ytd-rich-item-renderer:has(a[href="/shorts"])',
    'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
    'ytd-video-renderer:has(a[href^="/shorts/"])',
    'ytd-grid-video-renderer:has(a[href^="/shorts/"])',
    'ytd-compact-video-renderer:has(a[href^="/shorts/"])',
    'ytd-search-result-renderer:has(a[href^="/shorts/"])',
    'ytd-guide-entry-renderer:has(a[href^="/shorts/"])',
    'tp-yt-paper-item:has(a[href^="/shorts/"])'
  ];

  function isShortsRoute() {
    return location.pathname === "/shorts" || location.pathname.startsWith("/shorts/");
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Hide Shorts navigation, shelves, cards, and suggestions as soon as
         YouTube creates them, including during SPA navigation. */
      ${SHORTS_SELECTORS.join(",\n      ")} {
        display: none !important;
      }

      [${HIDDEN_ATTRIBUTE}="true"] {
        display: none !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function leaveShortsRoute() {
    if (!isShortsRoute()) {
      return;
    }

    // Keep the user on YouTube while preventing the Shorts player from being
    // shown. Replace the URL so Back does not immediately reopen Shorts.
    location.replace("/");
  }

  function hideShortsContainers() {
    for (const link of document.querySelectorAll('a[href="/shorts"], a[href^="/shorts/"], a[href="https://www.youtube.com/shorts"], a[href^="https://www.youtube.com/shorts/"]')) {
      const container = link.closest(
        "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-search-result-renderer, ytd-reel-item-renderer, ytd-guide-entry-renderer, tp-yt-paper-item"
      );

      if (container) {
        container.setAttribute(HIDDEN_ATTRIBUTE, "true");
      }
    }
  }

  function refresh() {
    if (!active) return;
    leaveShortsRoute();
    hideShortsContainers();
  }

  let refreshQueued = false;
  function queueRefresh() {
    if (refreshQueued) {
      return;
    }

    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      refresh();
    });
  }

  addStyles();
  queueRefresh();

  const observer = new MutationObserver(queueRefresh);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener("yt-navigate-finish", queueRefresh);
  window.addEventListener("popstate", queueRefresh);
  return () => {
    active = false;
    observer.disconnect();
    window.removeEventListener("yt-navigate-finish", queueRefresh);
    window.removeEventListener("popstate", queueRefresh);
    document.getElementById(STYLE_ID)?.remove();
    document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`).forEach(node => node.removeAttribute(HIDDEN_ATTRIBUTE));
  };
});
