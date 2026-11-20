import { initializeTabHistory } from "../modules/tab-history.js";
import { initializeAdBlocker } from "../modules/ad-blocker.js";
import { initializeTabMarkers } from "../modules/tab-marker.js";
import { initializeCsvViewer } from "../modules/csv-viewer.js";
import { initializeMailAccounts } from "../modules/mail-accounts.js";

initializeTabHistory();
initializeTabMarkers();
initializeAdBlocker();
initializeCsvViewer();
initializeMailAccounts();

const strongPasswordMenuId = "suggest-strong-password";
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: strongPasswordMenuId,
    title: "Suggest strong password",
    contexts: ["editable"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== strongPasswordMenuId || tab?.id == null) return;
  // Keep generation and insertion in the target frame. The password never
  // crosses the extension messaging boundary or enters service-worker state.
  chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
    func: () => {
      const field = document.activeElement;
      if (!(field instanceof HTMLInputElement) || field.type !== "password" || field.disabled || field.readOnly) return;
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+";
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      let password = "";
      for (const byte of bytes) password += alphabet[byte % alphabet.length];
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(field, password);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }).catch(() => {});
});

chrome.commands.onCommand.addListener(command => {
  if (command !== "highlight-selection") return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
    if (tab?.id == null) return;
    chrome.tabs.sendMessage(tab.id, { type: "text-highlights:save-selection" }).catch(() => {
      // Restricted pages and tabs without the content script cannot be highlighted.
    });
  }).catch(() => {});
});

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
  if (message?.type === "huggingface-model-created-at") {
    if (!sender.url?.startsWith("https://huggingface.co/")) return;

    const { owner, model } = message;
    if (![owner, model].every(part => typeof part === "string" && /^[\w.-]+$/.test(part))) {
      sendResponse({ error: "Invalid model" });
      return;
    }

    const query = new URLSearchParams();
    query.append("expand[]", "createdAt");
    query.append("expand[]", "lastModified");
    const modelApi = `https://huggingface.co/api/models/${encodeURIComponent(owner)}/${encodeURIComponent(model)}`;
    // Sum the current revision, not usedStorage (which includes repository history).
    const repoSize = (async () => {
      let url = `${modelApi}/tree/main?recursive=true&limit=1000`;
      let total = 0;
      while (url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Hugging Face tree API returned ${response.status}`);
        const entries = await response.json();
        for (const entry of entries) {
          if (entry.type === "file" && Number.isFinite(entry.size) && entry.size >= 0) {
            total += entry.size;
          }
        }
        const next = response.headers.get("Link")?.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? new URL(next[1], url).href : "";
        if (url && new URL(url).origin !== "https://huggingface.co") {
          throw new Error("Invalid Hugging Face pagination URL");
        }
      }
      return total;
    })().catch(() => null);
    fetch(`${modelApi}?${query}`)
      .then(async response => {
        if (!response.ok) throw new Error(`Hugging Face API returned ${response.status}`);
        const data = await response.json();
        if (typeof data.createdAt !== "string") throw new Error("Missing upload date");
        sendResponse({ createdAt: data.createdAt, lastModified: data.lastModified, repoSize: await repoSize });
      }).catch(error => sendResponse({ error: error.message }));
    return true;
  }

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
