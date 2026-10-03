import { initializeTabHistory } from "../modules/tab-history.js";
import { initializeTabMarkers } from "../modules/tab-marker.js";

initializeTabHistory();
initializeTabMarkers();

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
