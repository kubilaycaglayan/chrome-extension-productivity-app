import { isModuleEnabled } from "./settings.js";

const STORAGE_KEY = "windowTabHistory";

async function getHistory() {
  const result = await chrome.storage.session.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

async function saveHistory(history) {
  await chrome.storage.session.set({
    [STORAGE_KEY]: history
  });
}

export function initializeTabHistory() {
  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (!await isModuleEnabled("tab-history")) return;
    const history = await getHistory();
    const windowHistory = history[windowId];

    if (windowHistory?.current === tabId) {
      return;
    }

    history[windowId] = {
      current: tabId,
      previous: windowHistory?.current ?? windowHistory?.previous
    };

    await saveHistory(history);
  });

  chrome.tabs.onRemoved.addListener(async (tabId, { windowId }) => {
    const history = await getHistory();
    const windowHistory = history[windowId];

    if (!windowHistory) {
      return;
    }

    if (
      windowHistory.current === tabId ||
      windowHistory.previous === tabId
    ) {
      delete history[windowId];
      await saveHistory(history);
    }
  });

  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "toggle-last-tab") {
      return;
    }
    if (!await isModuleEnabled("tab-history")) return;

    const [currentTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });

    if (currentTab?.id == null || currentTab.windowId == null) {
      return;
    }

    const history = await getHistory();
    const windowHistory = history[currentTab.windowId];
    const targetTabId = windowHistory?.previous;

    if (targetTabId == null) {
      return;
    }

    try {
      await chrome.tabs.update(targetTabId, { active: true });
    } catch {
      // The previously visited tab may have been closed.
      delete history[currentTab.windowId];
      await saveHistory(history);
    }
  });
}
