import { isModuleEnabled } from "./settings.js";

const STORAGE_KEY = "windowTabHistory";
const MAX_RECENT_TABS = 20;

async function getHistory() {
  const result = await chrome.storage.session.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

async function saveHistory(history) {
  await chrome.storage.session.set({ [STORAGE_KEY]: history });
}

// Older releases stored only a current/previous pair. Keep that pair when
// upgrading, then record a longer most-recent-first list for each window.
function recentTabs(value) {
  const ids = Array.isArray(value) ? value : [value?.current, value?.previous];
  return [...new Set(ids.filter(id => Number.isInteger(id)))].slice(0, MAX_RECENT_TABS);
}

function visit(value, tabId) {
  return [tabId, ...recentTabs(value).filter(id => id !== tabId)].slice(0, MAX_RECENT_TABS);
}

export function initializeTabHistory() {
  // Storage updates are asynchronous. Process tab events and commands in the
  // order received so a later activation cannot be overwritten by an older one.
  let pending = Promise.resolve();
  function enqueue(work) {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  }

  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => enqueue(async () => {
    if (!await isModuleEnabled("tab-history")) return;
    const history = await getHistory();
    const recent = recentTabs(history[windowId]);
    if (recent[0] === tabId) return;
    history[windowId] = visit(recent, tabId);
    await saveHistory(history);
  }));

  chrome.tabs.onRemoved.addListener((tabId, { windowId }) => enqueue(async () => {
    const history = await getHistory();
    if (!(windowId in history)) return;
    const recent = recentTabs(history[windowId]).filter(id => id !== tabId);
    if (recent.length) history[windowId] = recent;
    else delete history[windowId];
    await saveHistory(history);
  }));

  chrome.commands.onCommand.addListener(command => enqueue(async () => {
    if (command !== "toggle-last-tab") return;
    if (!await isModuleEnabled("tab-history")) return;

    const [currentTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });
    if (currentTab?.id == null || currentTab.windowId == null) return;

    const history = await getHistory();
    let recent = visit(history[currentTab.windowId], currentTab.id);

    // Only the immediately previous live tab is selected. Older visits are
    // candidates only when a tab has closed since it was last seen.
    for (const targetTabId of recent.slice(1)) {
      try {
        await chrome.tabs.update(targetTabId, { active: true });
        break;
      } catch {
        recent = recent.filter(id => id !== targetTabId);
      }
    }

    history[currentTab.windowId] = recent;
    await saveHistory(history);
  }));
}
