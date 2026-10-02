productivityModules.register("youtube-section-toggle", () => {
  let active = true;
  const originalDisplays = new Map();
  const STORAGE_KEY = "youtubeSectionsHidden";
  const BUTTON_ID = "productivity-youtube-section-toggle";
  const STYLE_ID = "productivity-youtube-section-toggle-style";
  const HIDDEN_ATTRIBUTE = "data-productivity-hidden";

  let sectionsHidden = false;
  let refreshQueued = false;

  const SECTION_SELECTORS = {
    watch: "#related",
    home: "ytd-browse[page-subtype=home] #contents, #contents"
  };

  function isHomePage() {
    return location.pathname === "/";
  }

  function getTargetSelector() {
    return location.pathname === "/watch" && location.search
      ? SECTION_SELECTORS.watch
      : isHomePage()
        ? SECTION_SELECTORS.home
        : null;
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        --productivity-button-background: #f2f2f2;
        --productivity-button-background-hover: #e5e5e5;
        --productivity-button-text: #0f0f0f;
        align-items: center;
        background: var(--yt-spec-badge-chip-background, var(--productivity-button-background));
        border: 0;
        border-radius: 4px;
        color: var(--yt-spec-text-primary, var(--productivity-button-text));
        cursor: pointer;
        display: inline-flex;
        font: 500 16px/1 Roboto, Arial, sans-serif;
        height: 32px;
        justify-content: center;
        margin: 12px 0 0 8px;
        padding: 0 10px;
        box-sizing: border-box;
        pointer-events: auto;
        position: relative;
        flex-shrink: 0;
        z-index: 1000;
        transition: background-color 120ms ease;
        width: auto;
      }

      #${BUTTON_ID}:hover {
        background: var(--yt-spec-button-chip-background-hover, var(--productivity-button-background-hover));
      }

      #${BUTTON_ID}:focus-visible {
        outline: 2px solid var(--yt-spec-call-to-action, #065fd4);
        outline-offset: 2px;
      }

      @media (prefers-color-scheme: dark) {
        #${BUTTON_ID} {
          --productivity-button-background: #272727;
          --productivity-button-background-hover: #3f3f3f;
          --productivity-button-text: #f1f1f1;
        }
      }

      html[dark] #${BUTTON_ID} {
        --productivity-button-background: #272727;
        --productivity-button-background-hover: #3f3f3f;
        --productivity-button-text: #f1f1f1;
      }

      [${HIDDEN_ATTRIBUTE}="true"] {
        display: none !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function updateButton(button) {
    const label = sectionsHidden ? "Focus" : "Entertain";
    if (button.textContent !== label) {
      button.textContent = label;
    }
    button.title = sectionsHidden
      ? "Show recommendations"
      : "Hide recommendations";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(sectionsHidden));
  }

  function updateSection() {
    const selector = getTargetSelector();

    if (!selector) {
      return;
    }

    for (const section of document.querySelectorAll(selector)) {
      if (!originalDisplays.has(section)) {
        originalDisplays.set(section, [section.style.getPropertyValue("display"), section.style.getPropertyPriority("display")]);
      }
      section.toggleAttribute(HIDDEN_ATTRIBUTE, sectionsHidden);

      if (sectionsHidden) {
        section.style.setProperty("display", "none", "important");
      } else {
        const [value, priority] = originalDisplays.get(section);
        if (value) section.style.setProperty("display", value, priority);
        else section.style.removeProperty("display");
      }
    }
  }

  async function toggleSections(button) {
    sectionsHidden = !sectionsHidden;
    updateSection();
    updateButton(button);

    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: sectionsHidden });
    } catch {
      // The visual state remains usable even if storage is temporarily unavailable.
    }
  }

  function ensureButton() {
    const existingButton = document.getElementById(BUTTON_ID);
    const logoIcon = document.getElementById("logo-icon");
    const countryCode = document.getElementById("country-code");
    const placementTarget = countryCode || logoIcon;

    if (!getTargetSelector()) {
      existingButton?.remove();
      return;
    }

    if (!placementTarget) {
      return;
    }

    const button = existingButton || document.createElement("button");

    if (!existingButton) {
      button.id = BUTTON_ID;
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggleSections(button);
      }, true);
    }

    if (button.previousElementSibling !== placementTarget) {
      placementTarget.insertAdjacentElement("afterend", button);
    }

    updateButton(button);
  }

  function refresh() {
    if (!active) return;
    refreshQueued = false;
    addStyles();
    ensureButton();
    updateSection();
  }

  function queueRefresh() {
    if (refreshQueued) {
      return;
    }

    refreshQueued = true;
    requestAnimationFrame(refresh);
  }

  async function restoreState() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      if (!active) return;
      sectionsHidden = Boolean(result[STORAGE_KEY]);
    } finally {
      queueRefresh();
    }
  }

  const observer = new MutationObserver(queueRefresh);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener("yt-navigate-finish", queueRefresh);
  window.addEventListener("popstate", queueRefresh);
  restoreState();
  return () => {
    active = false;
    observer.disconnect();
    window.removeEventListener("yt-navigate-finish", queueRefresh);
    window.removeEventListener("popstate", queueRefresh);
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    for (const [section, [value, priority]] of originalDisplays) {
      section.removeAttribute(HIDDEN_ATTRIBUTE);
      if (value) section.style.setProperty("display", value, priority);
      else section.style.removeProperty("display");
    }
  };
});
