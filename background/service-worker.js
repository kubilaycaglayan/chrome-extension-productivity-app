import { initializeTabHistory } from "../modules/tab-history.js";
import { initializeAdBlocker } from "../modules/ad-blocker.js";
import { initializeTabMarkers } from "../modules/tab-marker.js";
import { initializeCsvViewer } from "../modules/csv-viewer.js";

initializeTabHistory();
initializeTabMarkers();
initializeAdBlocker();
initializeCsvViewer();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const globalEnabled = changes["moduleEnabled:dark-mode"]?.newValue === true;
  const sitesEnabled = changes.darkModeSites && Array.isArray(changes.darkModeSites.newValue) && changes.darkModeSites.newValue.length > 0;
  if (!globalEnabled && !sitesEnabled) return;
  // Content scripts begin on navigation. Cover tabs that were already open
  // when the extension was installed or reloaded as well.
  chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs
    .filter(tab => tab.id != null && /^(https?:\/\/|file:\/\/)/.test(tab.url || ""))
    .map(tab => chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/dark-mode.js"]
    })))).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "github-repository-created-at") return;
  if (!sender.url?.startsWith("https://github.com/")) return;

  const { owner, repo } = message;
  if (![owner, repo].every(part => typeof part === "string" && /^[\w.-]+$/.test(part))) {
    sendResponse({ error: "Invalid repository" });
    return;
  }

  fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: { Accept: "application/vnd.github+json" }
  }).then(async response => {
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    const data = await response.json();
    if (typeof data.created_at !== "string") throw new Error("Missing creation date");
    sendResponse({ createdAt: data.created_at });
  }).catch(error => sendResponse({ error: error.message }));
  return true;
});
