const MODULES = [
  ["tab-history", "Recent-tab switching", "Switch between your two most recent tabs.", "browser", "🔁"],
  ["tab-marker", "Tab markers", "Mark tabs with colored emoji from the context menu.", "browser", "🏷️"],
  ["newtab", "New Tab page", "Search bar with Google suggestions, draggable bookmark groups, and Google or custom wallpapers.", "browser", "🗂️"],
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

async function initialize() {
  try {
    const keys = MODULES.map(([id]) => `moduleEnabled:${id}`);
    const settings = await chrome.storage.local.get([...keys, mackolikSettings.key, mackolikSettings.followedKey, xKeywords.key]);
    const teams = settings[mackolikSettings.key];
    teamEditor.value = (Array.isArray(teams) ? mackolikSettings.clean(teams) : mackolikSettings.defaults).join("\n");
    teamEditor.disabled = false;
    followedEditor.value = mackolikSettings.clean(settings[mackolikSettings.followedKey] || []).join("\n");
    followedEditor.disabled = false;
    saveTeams.disabled = false;
    wordEditor.value = (Array.isArray(settings[xKeywords.key]) ? xKeywords.clean(settings[xKeywords.key]) : xKeywords.defaults).join("\n");
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
      input.checked = settings[key] !== false;
      inputs.set(key, input);
      input.addEventListener("change", async () => {
        const enabled = input.checked;
        input.disabled = true;
        try {
          await chrome.storage.local.set({ [key]: enabled });
          status.textContent = `${name} ${enabled ? "enabled" : "disabled"}.`;
        } catch {
          input.checked = !enabled;
          status.textContent = "Could not save. Please try again.";
        } finally {
          input.disabled = false;
        }
      });
      row.append(emoji, copy, input);
      document.getElementById(`group-${group}`).appendChild(row);
    }
    status.textContent = "Changes apply immediately and are saved.";
  } catch {
    status.textContent = "Could not load settings. Reopen the popup to retry.";
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, change] of Object.entries(changes)) {
    const input = inputs.get(key);
    if (input) input.checked = change.newValue !== false;
  }
  if (changes[xKeywords.key]) {
    const words = changes[xKeywords.key].newValue;
    wordEditor.value = (Array.isArray(words) ? xKeywords.clean(words) : xKeywords.defaults).join("\n");
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
    const settings = await chrome.storage.local.get([...keys, mackolikSettings.key, mackolikSettings.followedKey, newtabSettings.groupsKey, newtabSettings.backgroundKey, xKeywords.key]);
    const modules = Object.fromEntries(MODULES.map(([id]) => [id, settings[`moduleEnabled:${id}`] !== false]));
    const teams = settings[mackolikSettings.key];
    const highlightedTeams = Array.isArray(teams) ? mackolikSettings.clean(teams) : mackolikSettings.defaults;
    const followedTeams = mackolikSettings.clean(settings[mackolikSettings.followedKey] || []);
    const blockedWords = Array.isArray(settings[xKeywords.key]) ? xKeywords.clean(settings[xKeywords.key]) : xKeywords.defaults;
    const newtabGroups = newtabSettings.cleanGroups(settings[newtabSettings.groupsKey] || []);
    const newtabBackground = newtabSettings.cleanBackground(settings[newtabSettings.backgroundKey]);
    const backup = { version: 1, modules, highlightedTeams, followedTeams, blockedWords, newtabGroups, newtabBackground };
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
    await chrome.storage.local.set(settings);
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
