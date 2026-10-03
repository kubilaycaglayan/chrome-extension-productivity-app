productivityModules.register("x-keyword-filter", () => {
  let active = true;
  let blockedWords = xKeywords.defaults.map(word => word.toLowerCase());
  const marker = "data-productivity-keyword-hidden";
  const style = document.createElement("style");
  style.textContent = `article[${marker}] { display: none !important; }`;
  (document.head || document.documentElement).appendChild(style);

  function processTweets() {
    for (const article of document.querySelectorAll("article")) {
      const text = article.textContent.toLowerCase();
      const blocked = blockedWords.some(word => text.includes(word));
      if (blocked) article.setAttribute(marker, "");
      else article.removeAttribute(marker);
    }
  }

  let queued = false;
  function queueProcess() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (active) processTweets();
    });
  }

  function applyWords(value) {
    const words = Array.isArray(value) ? xKeywords.clean(value) : xKeywords.defaults;
    blockedWords = words.map(word => word.toLowerCase());
    queueProcess();
  }

  let revision = 0;
  function onStorageChanged(changes, area) {
    if (area !== "local" || !changes[xKeywords.key]) return;
    revision++;
    applyWords(changes[xKeywords.key].newValue);
  }
  chrome.storage.onChanged.addListener(onStorageChanged);
  const initialRevision = revision;
  chrome.storage.local.get(xKeywords.key).then(result => {
    if (active && revision === initialRevision) applyWords(result[xKeywords.key]);
  }).catch(error => console.warn("[X Keyword Filter]", error));

  const observer = new MutationObserver(queueProcess);
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  queueProcess();

  return () => {
    active = false;
    observer.disconnect();
    chrome.storage.onChanged.removeListener(onStorageChanged);
    style.remove();
    document.querySelectorAll(`article[${marker}]`).forEach(article => article.removeAttribute(marker));
  };
});
