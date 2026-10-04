const MODULES = [
  ["ad-blocker", "Ad blocker", "Block ads and hide ad spaces. Pause it on sites that need an exception.", "browser", "🛡️"],
  ["page-outline", "Page outline", "Show a clickable outline of headings on the current page.", "browser", "📑"],
  ["tab-history", "Recent-tab switching", "Switch between your two most recent tabs.", "browser", "🔁"],
  ["tab-marker", "Tab markers", "Mark tabs with colored emoji from the context menu.", "browser", "🏷️"],
  ["newtab", "New Tab page", "Search bar with Google suggestions, draggable bookmark groups, and Google or custom wallpapers.", "browser", "🗂️"],
  ["cookie-accepter", "Cookie accepter", "Automatically accept all cookie categories, including optional analytics and marketing, on recognized banners. Off until enabled.", "browser", "🍪"],
  ["youtube-section-toggle", "YouTube recommendations", "Add a button to show or hide recommendations.", "youtube", "🎛️"],
  ["youtube-shorts-blocker", "YouTube Shorts blocker", "Hide Shorts and redirect Shorts pages to Home.", "youtube", "🚫"],
  ["mackolik-dark-theme", "Mackolik dark theme", "Repaint every arsiv.mackolik.com page dark, keeping the site's own colour coding.", "mackolik", "🌙"],
  ["mackolik-featured-video", "Mackolik cleanup", "Enlarge text, highlight teams, show TV channels for followed matches, and hide ads, the right panel, video, header, and menus.", "mackolik", "🧹"],
  ["x-keyword-filter", "X keyword filter", "Hide posts on X and Twitter that contain your blocked phrases.", "x", "🛡️"],
  ["github-creation-date", "GitHub creation date", "Show a repository's creation date beside its About heading.", "other-sites", "🐙"],
  ["calendar-highlight-today", "Calendar: highlight today", "Outline today's date cell in red in Google Calendar.", "other-sites", "📅"],
  ["scrollbar-width", "Wider scrollbars", "Make Hugging Face scrollbars easier to grab.", "other-sites", "↔️"]
];

const status = document.getElementById("status");
const inputs = new Map();
const teamEditor = document.getElementById("highlight-teams");
const followedEditor = document.getElementById("followed-teams");
const saveTeams = document.getElementById("save-highlight-teams");
const wordEditor = document.getElementById("blocked-words");
const saveWords = document.getElementById("save-blocked-words");

// Personal lists are kept in gitignored files beside the extension rather than
// in the source, so a fresh profile still starts with them while the
// repository ships none. A missing file simply prefills nothing.
async function loadLocalList(file, clean) {
  try {
    const response = await fetch(chrome.runtime.getURL(file));
    if (!response.ok) return [];
    const values = await response.json();
    return Array.isArray(values) ? clean(values) : [];
  } catch {
    return [];
  }
}

const outlineView = document.getElementById("outline-view");
const settingsView = document.getElementById("settings-view");
const outlineList = document.getElementById("outline-list");
const outlineMessage = document.getElementById("outline-message");
const darkModeToggle = document.getElementById("dark-mode-toggle");
const darkModeSiteToggle = document.getElementById("dark-mode-site-toggle");
const darkModeKey = "moduleEnabled:dark-mode";
const darkModeSitesKey = "darkModeSites";
const cookiePauseToggle = document.getElementById("cookie-pause-toggle");
const adSitesKey = "adBlockerPausedSites";
const adSiteToggle = document.getElementById("ad-blocker-site-toggle");
const adSitesEditor = document.getElementById("ad-blocker-sites");
const adSitesSave = document.getElementById("save-ad-blocker-sites");
let pausedAdSites = [];
let adBlockerReady = false;
let currentSite = null;
let outlineTabId = null;

Promise.all([
  chrome.tabs.query({ active: true, currentWindow: true }),
  chrome.storage.local.get([darkModeKey, darkModeSitesKey, cookieAccepterSettings.pausedKey])
]).then(([tabs, settings]) => {
  darkModeToggle.checked = settings[darkModeKey] === true;
  darkModeToggle.disabled = false;
  try {
    const url = new URL(tabs[0]?.url);
    if (url.protocol === "http:" || url.protocol === "https:") currentSite = url.hostname.toLowerCase();
  } catch { /* Restricted browser pages have no site switch. */ }
  if (currentSite) {
    darkModeSiteToggle.checked = Array.isArray(settings[darkModeSitesKey]) && settings[darkModeSitesKey].includes(currentSite);
    darkModeSiteToggle.title = currentSite;
    darkModeSiteToggle.disabled = false;
    cookiePauseToggle.checked = cookieAccepterSettings.cleanSites(settings[cookieAccepterSettings.pausedKey]).includes(currentSite);
    cookiePauseToggle.disabled = false;
    cookiePauseToggle.title = currentSite;
    refreshAdSiteToggle();
  } else {
    darkModeSiteToggle.title = "Available on website tabs";
    cookiePauseToggle.title = "Available on website tabs";
  }
}).catch(() => {
  darkModeToggle.title = "Could not load dark mode setting. Reopen the popup to retry.";
});
cookiePauseToggle.addEventListener("change", async () => {
  if (!currentSite) return;
  const paused = cookiePauseToggle.checked;
  cookiePauseToggle.disabled = true;
  try {
    const key = cookieAccepterSettings.pausedKey;
    const stored = await chrome.storage.local.get(key);
    const sites = new Set(cookieAccepterSettings.cleanSites(stored[key]));
    if (paused) sites.add(currentSite);
    else sites.delete(currentSite);
    await chrome.storage.local.set({ [key]: [...sites] });
    status.textContent = `Cookie accepter ${paused ? "paused" : "resumed"} on ${currentSite}.`;
  } catch {
    cookiePauseToggle.checked = !paused;
    status.textContent = "Could not save this site's cookie setting.";
  } finally { cookiePauseToggle.disabled = false; }
});
darkModeToggle.addEventListener("change", async () => {
  const enabled = darkModeToggle.checked;
  darkModeToggle.disabled = true;
  try {
    await chrome.storage.local.set({ [darkModeKey]: enabled });
  } catch {
    darkModeToggle.checked = !enabled;
    darkModeToggle.title = "Could not save dark mode setting. Please try again.";
  } finally {
    darkModeToggle.disabled = false;
  }
});
darkModeSiteToggle.addEventListener("change", async () => {
  if (!currentSite) return;
  const enabled = darkModeSiteToggle.checked;
  darkModeSiteToggle.disabled = true;
  try {
    const settings = await chrome.storage.local.get(darkModeSitesKey);
    const sites = new Set(Array.isArray(settings[darkModeSitesKey]) ? settings[darkModeSitesKey] : []);
    if (enabled) sites.add(currentSite);
    else sites.delete(currentSite);
    await chrome.storage.local.set({ [darkModeSitesKey]: [...sites] });
  } catch {
    darkModeSiteToggle.checked = !enabled;
    darkModeSiteToggle.title = "Could not save this site's setting. Please try again.";
  } finally {
    darkModeSiteToggle.disabled = false;
  }
});

function showView(view) {
  outlineView.hidden = view !== "outline";
  settingsView.hidden = view !== "settings";
  document.body.scrollTop = 0;
  if (view === "outline") void loadOutline();
}

// This function runs inside the active page. Keep it self-contained for executeScript.
function collectPageHeadings() {
  const selector = "h1,h2,h3,h4,h5,h6";
  const all = [...document.querySelectorAll(selector)];
  const main = document.querySelector("main, [role='main']");
  const visible = heading => {
    if (!heading.textContent.trim() || heading.closest("[hidden], [aria-hidden='true'], template")) return false;
    const style = getComputedStyle(heading);
    return style.display !== "none" && style.visibility !== "hidden" && heading.getClientRects().length > 0;
  };
  const candidates = main && all.some(heading => main.contains(heading) && visible(heading))
    ? all.filter(heading => main.contains(heading)) : all;
  return candidates.filter(visible).slice(0, 300).map(heading => ({
    index: all.indexOf(heading),
    level: Number(heading.tagName.slice(1)),
    text: heading.textContent.replace(/\s+/g, " ").trim().slice(0, 240)
  }));
}

function jumpToHeading(index, expectedText) {
  const heading = document.querySelectorAll("h1,h2,h3,h4,h5,h6")[index];
  if (!heading || heading.textContent.replace(/\s+/g, " ").trim().slice(0, 240) !== expectedText) return false;
  heading.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

async function loadOutline() {
  outlineList.replaceChildren();
  outlineMessage.hidden = false;
  outlineMessage.textContent = "Finding headings…";
  document.getElementById("outline-count").textContent = "OUTLINE";
  document.getElementById("outline-hint").textContent = "Click to jump";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    outlineTabId = tab?.id ?? null;
    const { "moduleEnabled:page-outline": enabled } = await chrome.storage.local.get("moduleEnabled:page-outline");
    if (enabled === false) {
      outlineMessage.textContent = "Page outline is turned off. Enable it in Settings.";
      return;
    }
    if (outlineTabId === null) throw new Error("No active tab");
    const [{ result: headings }] = await chrome.scripting.executeScript({ target: { tabId: outlineTabId }, func: collectPageHeadings });
    document.getElementById("outline-count").textContent = `${headings.length} ${headings.length === 1 ? "HEADING" : "HEADINGS"}`;
    if (!headings.length) {
      outlineMessage.textContent = "No headings found on this page.";
      return;
    }
    const parents = [];
    headings.forEach(heading => {
      while (parents.length && parents.at(-1).level >= heading.level) parents.pop();
      const depth = parents.length;
      const node = document.createElement("div");
      node.className = "outline-node";
      node.dataset.depth = String(depth);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "outline-item";
      button.dataset.depth = String(depth);
      button.title = heading.text;
      const label = document.createElement("span");
      label.className = "outline-text";
      label.textContent = heading.text;
      const arrow = document.createElement("span");
      arrow.className = "outline-arrow";
      arrow.textContent = "↗";
      arrow.setAttribute("aria-hidden", "true");
      button.append(label, arrow);
      button.addEventListener("click", async () => {
        try {
          const [{ result: found }] = await chrome.scripting.executeScript({ target: { tabId: outlineTabId }, func: jumpToHeading, args: [heading.index, heading.text] });
          if (found) window.close();
          else outlineMessage.textContent = "This heading moved. Refresh the outline and try again.";
        } catch { outlineMessage.textContent = "Could not jump to this heading."; }
        outlineMessage.hidden = false;
      });
      const children = document.createElement("div");
      children.className = "outline-children";
      node.append(button, children);
      const parent = parents.at(-1);
      if (parent) {
        if (!parent.toggle) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "outline-chevron";
          toggle.setAttribute("aria-expanded", "true");
          toggle.setAttribute("aria-label", `Collapse ${parent.heading.text}`);
          parent.children.id = `outline-children-${parent.heading.index}`;
          toggle.setAttribute("aria-controls", parent.children.id);
          toggle.addEventListener("click", () => {
            const expanded = toggle.getAttribute("aria-expanded") === "true";
            parent.children.hidden = expanded;
            toggle.setAttribute("aria-expanded", String(!expanded));
            toggle.setAttribute("aria-label", `${expanded ? "Expand" : "Collapse"} ${parent.heading.text}`);
          });
          parent.node.classList.add("has-children");
          parent.node.prepend(toggle);
          parent.toggle = toggle;
        }
        parent.children.append(node);
      } else {
        outlineList.append(node);
      }
      parents.push({ level: heading.level, heading, node, children, toggle: null });
    });
    outlineMessage.hidden = true;
  } catch {
    outlineMessage.textContent = "This page cannot be outlined. Try a regular website tab.";
  }
}

document.getElementById("open-settings").addEventListener("click", () => showView("settings"));
document.getElementById("back-to-outline").addEventListener("click", () => showView("outline"));
document.getElementById("refresh-outline").addEventListener("click", () => void loadOutline());
void loadOutline();

async function initialize() {
  try {
    const keys = MODULES.map(([id]) => `moduleEnabled:${id}`);
    const settings = await chrome.storage.local.get([...keys, mackolikSettings.key, mackolikSettings.followedKey, xKeywords.key]);
    const teams = settings[mackolikSettings.key];
    teamEditor.value = (Array.isArray(teams)
      ? mackolikSettings.clean(teams)
      : await loadLocalList("mackolik-teams.local.json", values => mackolikSettings.clean(values))).join("\n");
    teamEditor.disabled = false;
    followedEditor.value = mackolikSettings.clean(settings[mackolikSettings.followedKey] || []).join("\n");
    followedEditor.disabled = false;
    saveTeams.disabled = false;
    const blockedWords = Array.isArray(settings[xKeywords.key])
      ? xKeywords.clean(settings[xKeywords.key])
      : await loadLocalList("x-keywords.local.json", values => xKeywords.clean(values));
    wordEditor.value = blockedWords.join("\n");
    wordEditor.disabled = false;
    saveWords.disabled = false;
    for (const [id, name, description, group, icon] of MODULES) {
      const key = `moduleEnabled:${id}`;
      const row = document.createElement("label");
      row.className = "module";
      row.title = description;
      const copy = document.createElement("span");
      const emoji = document.createElement("span");
      emoji.className = "module-emoji";
      emoji.textContent = icon;
      emoji.setAttribute("aria-hidden", "true");
      const title = document.createElement("span");
      title.className = "name";
      title.textContent = name;
      const detail = document.createElement("span");
      detail.className = "description";
      detail.textContent = description;
      copy.append(title, detail);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("role", "switch");
      input.setAttribute("aria-label", name);
      input.checked = id === "cookie-accepter" ? settings[key] === true : settings[key] !== false;
      if (id === "ad-blocker") input.disabled = true;
      inputs.set(key, input);
      input.addEventListener("change", async () => {
        const enabled = input.checked;
        input.disabled = true;
        try {
          if (id === "ad-blocker") {
            const result = await chrome.runtime.sendMessage({ type: "ad-blocker:set-enabled", enabled });
            if (!result?.ok || result.enabled !== enabled) throw new Error(result?.error || "Could not change network rules.");
          } else await chrome.storage.local.set({ [key]: enabled });
          status.textContent = `${name} ${enabled ? "enabled" : "disabled"}.`;
        } catch {
          input.checked = !enabled;
          status.textContent = id === "ad-blocker" ? "Could not change ad blocking. Check extension errors and try again." : "Could not save. Please try again.";
        } finally {
          input.disabled = false;
        }
      });
      row.append(emoji, copy, input);
      document.getElementById(`group-${group}`).appendChild(row);
    }
    status.textContent = "Changes apply immediately and are saved.";
    await initializeAdControls();
  } catch {
    status.textContent = "Could not load settings. Reopen the popup to retry.";
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[darkModeKey]) darkModeToggle.checked = changes[darkModeKey].newValue === true;
  if (currentSite && changes[darkModeSitesKey]) {
    const sites = changes[darkModeSitesKey].newValue;
    darkModeSiteToggle.checked = Array.isArray(sites) && sites.includes(currentSite);
  }
  if (currentSite && changes[cookieAccepterSettings.pausedKey]) {
    cookiePauseToggle.checked = cookieAccepterSettings.cleanSites(changes[cookieAccepterSettings.pausedKey].newValue).includes(currentSite);
  }
  for (const [key, change] of Object.entries(changes)) {
    const input = inputs.get(key);
    if (input && key === "moduleEnabled:ad-blocker") {
      void chrome.runtime.sendMessage({ type: "ad-blocker:get" }).then(result => {
        if (result?.ok) input.checked = result.enabled;
      }).catch(() => {});
    } else if (input) input.checked = key === cookieAccepterSettings.key ? change.newValue === true : change.newValue !== false;
  }
  if (changes[adSitesKey]) {
    pausedAdSites = Array.isArray(changes[adSitesKey].newValue) ? changes[adSitesKey].newValue : [];
    if (document.activeElement !== adSitesEditor) adSitesEditor.value = pausedAdSites.join("\n");
    refreshAdSiteToggle();
  }
  if (changes[xKeywords.key]) {
    const words = changes[xKeywords.key].newValue;
    wordEditor.value = (Array.isArray(words) ? xKeywords.clean(words) : []).join("\n");
  }
});
void initialize();

document.getElementById("highlight-settings").addEventListener("submit", async event => {
  event.preventDefault();
  saveTeams.disabled = true;
  try {
    const teams = mackolikSettings.clean(teamEditor.value.split(/\r?\n/));
    const followed = mackolikSettings.clean(followedEditor.value.split(/\r?\n/));
    await chrome.storage.local.set({ [mackolikSettings.key]: teams, [mackolikSettings.followedKey]: followed });
    teamEditor.value = teams.join("\n");
    followedEditor.value = followed.join("\n");
    status.textContent = "Highlighted teams saved. Open Mackolik pages updated.";
  } catch {
    status.textContent = "Could not save teams. Please try again.";
  } finally {
    saveTeams.disabled = false;
  }
});

document.getElementById("keyword-settings").addEventListener("submit", async event => {
  event.preventDefault();
  saveWords.disabled = true;
  try {
    const words = xKeywords.clean(wordEditor.value.split(/\r?\n/));
    await chrome.storage.local.set({ [xKeywords.key]: words });
    wordEditor.value = words.join("\n");
    status.textContent = "Blocked words saved. Open X and Twitter pages updated.";
  } catch {
    status.textContent = "Could not save blocked words. Please try again.";
  } finally {
    saveWords.disabled = false;
  }
});

document.getElementById("export-settings").addEventListener("click", async () => {
  try {
    const keys = MODULES.map(([id]) => `moduleEnabled:${id}`);
    const settings = await chrome.storage.local.get([...keys, darkModeKey, darkModeSitesKey, adSitesKey, cookieAccepterSettings.pausedKey, mackolikSettings.key, mackolikSettings.followedKey, newtabSettings.groupsKey, newtabSettings.backgroundKey, xKeywords.key]);
    const modules = Object.fromEntries(MODULES.map(([id]) => [id, id === "cookie-accepter" ? settings[`moduleEnabled:${id}`] === true : settings[`moduleEnabled:${id}`] !== false]));
    const teams = settings[mackolikSettings.key];
    const highlightedTeams = Array.isArray(teams) ? mackolikSettings.clean(teams) : [];
    const followedTeams = mackolikSettings.clean(settings[mackolikSettings.followedKey] || []);
    const blockedWords = Array.isArray(settings[xKeywords.key]) ? xKeywords.clean(settings[xKeywords.key]) : [];
    const newtabGroups = newtabSettings.cleanGroups(settings[newtabSettings.groupsKey] || []);
    const newtabBackground = newtabSettings.cleanBackground(settings[newtabSettings.backgroundKey]);
    const darkModeSites = Array.isArray(settings[darkModeSitesKey]) ? settings[darkModeSitesKey] : [];
    const cookieAccepterPausedSites = cookieAccepterSettings.cleanSites(settings[cookieAccepterSettings.pausedKey]);
    const backup = { version: 1, modules, adBlockerPausedSites: settings[adSitesKey] || [], darkMode: settings[darkModeKey] === true, darkModeSites, cookieAccepterPausedSites, highlightedTeams, followedTeams, blockedWords, newtabGroups, newtabBackground };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "productivity-settings.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = "Backup exported. Import it after reinstalling.";
  } catch {
    status.textContent = "Could not export settings. Please try again.";
  }
});

document.getElementById("import-settings").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.version !== 1 || !backup.modules) throw new Error("Invalid backup");
    const settings = {};
    for (const [id] of MODULES) {
      if (backup.modules[id] === undefined) continue;
      if (typeof backup.modules[id] !== "boolean") throw new Error("Invalid setting");
      settings[`moduleEnabled:${id}`] = backup.modules[id];
    }
    if (backup.modules["cookie-accepter"] === undefined) settings[cookieAccepterSettings.key] = false;
    if (backup.cookieAccepterPausedSites !== undefined) {
      if (!Array.isArray(backup.cookieAccepterPausedSites) || backup.cookieAccepterPausedSites.some(site => cookieAccepterSettings.normalizeHost(site) === null)) throw new Error("Invalid cookie pause sites");
      settings[cookieAccepterSettings.pausedKey] = cookieAccepterSettings.cleanSites(backup.cookieAccepterPausedSites);
    } else settings[cookieAccepterSettings.pausedKey] = [];
    if (backup.adBlockerPausedSites !== undefined) {
      const checked = await chrome.runtime.sendMessage({ type: "ad-blocker:validate-sites", sites: backup.adBlockerPausedSites });
      if (!checked?.ok) throw new Error(checked?.error || "Invalid paused sites");
      settings[adSitesKey] = checked.sites;
    }
    if (backup.darkMode !== undefined) {
      if (typeof backup.darkMode !== "boolean") throw new Error("Invalid dark mode setting");
      settings[darkModeKey] = backup.darkMode;
    }
    if (backup.darkModeSites !== undefined) {
      if (!Array.isArray(backup.darkModeSites) || backup.darkModeSites.some(site => typeof site !== "string" || site.length > 253)) throw new Error("Invalid dark mode sites");
      settings[darkModeSitesKey] = [...new Set(backup.darkModeSites.map(site => site.toLowerCase()))];
    }
    if (backup.highlightedTeams !== undefined) {
      if (!Array.isArray(backup.highlightedTeams) || backup.highlightedTeams.some(value => typeof value !== "string")) throw new Error("Invalid teams");
      settings[mackolikSettings.key] = mackolikSettings.clean(backup.highlightedTeams);
    }
    if (backup.followedTeams !== undefined) {
      if (!Array.isArray(backup.followedTeams) || backup.followedTeams.some(value => typeof value !== "string")) throw new Error("Invalid followed teams");
      settings[mackolikSettings.followedKey] = mackolikSettings.clean(backup.followedTeams);
    }
    if (backup.blockedWords !== undefined) {
      if (!Array.isArray(backup.blockedWords) || backup.blockedWords.some(value => typeof value !== "string")) throw new Error("Invalid blocked words");
      settings[xKeywords.key] = xKeywords.clean(backup.blockedWords);
    }
    if (backup.newtabGroups !== undefined) {
      if (!Array.isArray(backup.newtabGroups)) throw new Error("Invalid bookmark groups");
      settings[newtabSettings.groupsKey] = newtabSettings.cleanGroups(backup.newtabGroups);
    }
    if (backup.newtabBackground !== undefined) {
      settings[newtabSettings.backgroundKey] = newtabSettings.cleanBackground(backup.newtabBackground);
    }
    const importedAdEnabled = settings["moduleEnabled:ad-blocker"];
    const importedAdSites = settings[adSitesKey];
    delete settings["moduleEnabled:ad-blocker"];
    delete settings[adSitesKey];
    await chrome.storage.local.set(settings);
    if (importedAdEnabled !== undefined) {
      const result = await chrome.runtime.sendMessage({ type: "ad-blocker:set-enabled", enabled: importedAdEnabled });
      if (!result?.ok) throw new Error(result?.error || "Could not apply ad blocker setting");
    }
    if (importedAdSites !== undefined) {
      const result = await chrome.runtime.sendMessage({ type: "ad-blocker:set-sites", sites: importedAdSites });
      if (!result?.ok) throw new Error(result?.error || "Could not apply paused sites");
    }
    const adResult = await chrome.runtime.sendMessage({ type: "ad-blocker:reconcile" });
    if (!adResult?.ok) throw new Error(adResult?.error || "Could not apply ad rules");
    if (settings[mackolikSettings.key]) teamEditor.value = settings[mackolikSettings.key].join("\n");
    if (settings[mackolikSettings.followedKey]) followedEditor.value = settings[mackolikSettings.followedKey].join("\n");
    if (settings[xKeywords.key]) wordEditor.value = settings[xKeywords.key].join("\n");
    status.textContent = "Settings restored.";
  } catch {
    status.textContent = "Could not import. Choose a Productivity settings backup.";
  } finally {
    event.target.value = "";
  }
});


function refreshAdSiteToggle() {
  if (!currentSite || !adBlockerReady) return;
  const paused = pausedAdSites.some(site => currentSite === site || currentSite.endsWith(`.${site}`));
  adSiteToggle.textContent = paused ? "Resume on this site" : "Pause on this site";
  adSiteToggle.disabled = false;
}
async function initializeAdControls() {
  const result = await chrome.runtime.sendMessage({ type: "ad-blocker:get" });
  if (!result?.ok) throw new Error(result?.error || "Could not read ad rules");
  const input = inputs.get("moduleEnabled:ad-blocker");
  input.checked = result.enabled;
  input.disabled = false;
  pausedAdSites = result.sites;
  adSitesEditor.value = pausedAdSites.join("\n");
  adSitesEditor.disabled = false;
  adSitesSave.disabled = false;
  adBlockerReady = true;
  document.getElementById("ad-blocker-site-name").textContent = currentSite || "Open a website to pause blocking.";
  refreshAdSiteToggle();
  if (result.enabled && !result.extraEnabled) status.textContent = "Core ad rules active. Supplemental rules unavailable due to browser quota.";
}
async function saveAdSites(sites) {
  adSiteToggle.disabled = true;
  adSitesSave.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "ad-blocker:set-sites", sites });
    if (!result?.ok) throw new Error(result?.error || "Could not update sites");
    pausedAdSites = result.sites;
    adSitesEditor.value = pausedAdSites.join("\n");
    status.textContent = "Ad blocker site exceptions saved. Reload affected pages to restore network requests.";
  } catch (error) {
    status.textContent = error.message || "Could not save sites.";
  } finally {
    adSitesSave.disabled = false;
    refreshAdSiteToggle();
  }
}
adSiteToggle.addEventListener("click", () => {
  if (!currentSite) return;
  const paused = pausedAdSites.some(site => currentSite === site || currentSite.endsWith(`.${site}`));
  void saveAdSites(paused ? pausedAdSites.filter(site => currentSite !== site && !currentSite.endsWith(`.${site}`)) : [...pausedAdSites, currentSite]);
});
adSitesSave.addEventListener("click", () => void saveAdSites(adSitesEditor.value.split(/\r?\n/)));
