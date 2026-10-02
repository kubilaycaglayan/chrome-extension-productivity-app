import { isModuleEnabled } from "./settings.js";

const COLORS = {
  red: "🔴",
  orange: "🟠",
  yellow: "🟡",
  green: "🟢",
  blue: "🔵",
  purple: "🟣",
  black: "⚫",
  white: "⚪"
};

function sendMarkerToTab(tabId, marker) {
  chrome.tabs.sendMessage(tabId, {
    type: "set-marker",
    marker
  }, () => {
    void chrome.runtime.lastError;
    // Content scripts are unavailable on browser-internal pages.
  });
}

export function initializeTabMarkers() {
  async function createContextMenus() {
    await chrome.contextMenus.removeAll();
    if (!await isModuleEnabled("tab-marker")) return;

    chrome.contextMenus.create({
      id: "tab-marker",
      title: "Tab Marker",
      contexts: ["page"]
    });

    chrome.contextMenus.create({
      id: "marker-clear",
      parentId: "tab-marker",
      title: "✕ Clear",
      contexts: ["page"]
    });

    for (const [name, emoji] of Object.entries(COLORS)) {
      chrome.contextMenus.create({
        id: `marker-${name}`,
        parentId: "tab-marker",
        title: `${emoji} ${name}`,
        contexts: ["page"]
      });
    }
  }

  chrome.runtime.onInstalled.addListener(createContextMenus);
  chrome.runtime.onStartup.addListener(createContextMenus);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["moduleEnabled:tab-marker"]) {
      void createContextMenus();
    }
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!await isModuleEnabled("tab-marker")) return;
    if (tab?.id == null || !tab.url) {
      return;
    }

    if (info.menuItemId === "marker-clear") {
      await chrome.storage.local.remove(tab.url);
      sendMarkerToTab(tab.id, null);
      return;
    }

    const colorName = info.menuItemId.replace("marker-", "");
    const marker = COLORS[colorName];

    if (!marker) {
      return;
    }

    await chrome.storage.local.set({
      [tab.url]: marker
    });

    sendMarkerToTab(tab.id, marker);
  });
}
