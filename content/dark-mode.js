// An opt-in dark mode. Invert the rendered page so site-specific layouts
// remain intact, then invert photos and video back to their original colors.
(() => {
  if (globalThis.__productivityDarkModeStarted) return;
  globalThis.__productivityDarkModeStarted = true;
  const key = "moduleEnabled:dark-mode";
  const sitesKey = "darkModeSites";
  const site = location.hostname.toLowerCase();
  const root = document.documentElement;
  const style = document.createElement("style");
  style.id = "productivity-dark-mode";
  let globallyEnabled = false;
  let siteEnabled = false;
  let globalRevision = 0;
  let sitesRevision = 0;
  let scheduled = false;

  function isDarkBackground() {
    for (const element of [document.body, root]) {
      if (!element) continue;
      const match = getComputedStyle(element).backgroundColor.match(/^rgba?\(([^)]+)\)$/);
      if (!match) continue;
      const channels = match[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
      if (channels.length < 3 || (channels[3] ?? 1) < 0.9) continue;
      const [red, green, blue] = channels.slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.18;
    }
    return false;
  }

  function render() {
    scheduled = false;
    // Measure the site's own colors without our white canvas declaration.
    style.remove();
    if (!(globallyEnabled || siteEnabled) || isDarkBackground()) return;
    // An opaque canvas ensures transparent pages invert to dark as well.
    style.textContent = `html {
  filter: invert(1) hue-rotate(180deg) !important;
  background-color: white !important;
  color-scheme: light !important;
}
img, video, canvas, embed, object {
  filter: invert(1) hue-rotate(180deg) !important;
}`;
    if (style.parentNode !== root || root.lastElementChild !== style) root.appendChild(style);
  }

  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes[key] && !changes[sitesKey])) return;
    if (changes[key]) {
      globalRevision++;
      globallyEnabled = changes[key].newValue === true;
    }
    if (changes[sitesKey]) {
      sitesRevision++;
      siteEnabled = Array.isArray(changes[sitesKey].newValue) && changes[sitesKey].newValue.includes(site);
    }
    scheduleRender();
  });
  const initialGlobalRevision = globalRevision;
  const initialSitesRevision = sitesRevision;
  chrome.storage.local.get([key, sitesKey]).then(settings => {
    if (globalRevision === initialGlobalRevision) globallyEnabled = settings[key] === true;
    if (sitesRevision === initialSitesRevision) siteEnabled = Array.isArray(settings[sitesKey]) && settings[sitesKey].includes(site);
    scheduleRender();
  });

  // Many sites set their background after document_start or switch themes later.
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === "attributes" ||
      [...record.addedNodes, ...record.removedNodes].some(node =>
        node !== style && (node.nodeName === "STYLE" || node.nodeName === "LINK")))) scheduleRender();
  });
  observer.observe(root, { attributes: true, attributeFilter: ["class", "style"], childList: true });
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    if (document.head) observer.observe(document.head, { childList: true });
    scheduleRender();
  }, { once: true });
})();
