productivityModules.register("tab-marker", () => {
let active = true;
const MARKERS = [
  "🔴", "🟠", "🟡", "🟢",
  "🔵", "🟣", "⚫", "⚪"
];

let marker = null;

function removeMarker(title) {
  for (const emoji of MARKERS) {
    if (title.startsWith(`${emoji} `)) {
      return title.slice(emoji.length + 1);
    }

    if (title === emoji) {
      return "";
    }
  }

  return title;
}

function applyMarker() {
  const cleanTitle = removeMarker(document.title);
  document.title = marker ? `${marker} ${cleanTitle}` : cleanTitle;
}

async function restoreMarker() {
  const result = await chrome.storage.local.get(location.href);
  if (!active) return;
  marker = result[location.href] || null;
  applyMarker();
}

restoreMarker();

function keepMarkerOnTitle() {
  if (!marker) {
    return;
  }

  const cleanTitle = removeMarker(document.title);

  if (!document.title.startsWith(`${marker} `)) {
    document.title = `${marker} ${cleanTitle}`;
  }
}

let observedTitle = null;
const titleObserver = new MutationObserver(keepMarkerOnTitle);

function observeTitle() {
  const title = document.querySelector("title");

  if (!title || title === observedTitle) {
    return;
  }

  titleObserver.disconnect();
  observedTitle = title;
  titleObserver.observe(title, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

const headObserver = new MutationObserver(() => {
  observeTitle();
  keepMarkerOnTitle();

  if (observedTitle) {
    headObserver.disconnect();
  }
});

observeTitle();

if (!observedTitle && document.documentElement) {
  headObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

const onMessage = (message) => {
  if (message.type !== "set-marker") {
    return;
  }

  marker = message.marker;
  applyMarker();
};
chrome.runtime.onMessage.addListener(onMessage);

const onStorageChanged = (changes, areaName) => {
  if (areaName !== "local" || !changes[location.href]) {
    return;
  }

  marker = changes[location.href].newValue || null;
  applyMarker();
};
chrome.storage.onChanged.addListener(onStorageChanged);
return () => {
  active = false;
  titleObserver.disconnect();
  headObserver.disconnect();
  chrome.runtime.onMessage.removeListener(onMessage);
  chrome.storage.onChanged.removeListener(onStorageChanged);
  marker = null;
  applyMarker();
};
});
