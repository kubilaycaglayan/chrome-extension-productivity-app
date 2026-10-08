(() => {
  const HIGHLIGHT_NAME = "productivity-text-highlight";
  const COLOR = "#fff176";
  const pageKey = `textHighlights:${location.origin}${location.pathname}${location.search}`;
  let renderTimer;

  function eligibleTextNodes() {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!node.nodeValue?.length || !parent || parent.closest("script,style,noscript,textarea,input,select,option,[contenteditable='true'],[hidden]")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function nodePath(node) {
    const path = [];
    while (node && node !== document.documentElement) {
      const parent = node.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
      node = parent;
    }
    return node === document.documentElement ? path : null;
  }

  function nodeAtPath(path) {
    if (!Array.isArray(path) || path.some(index => !Number.isInteger(index) || index < 0)) return null;
    let node = document.documentElement;
    for (const index of path) {
      node = node?.childNodes[index];
      if (!node) return null;
    }
    return node;
  }

  function buildRanges(records) {
    if (!document.body || !CSS.highlights || typeof Highlight !== "function") return [];
    const nodes = eligibleTextNodes();
    let text = "";
    const spans = [];
    for (const node of nodes) {
      const start = text.length;
      text += node.nodeValue;
      spans.push({ node, start, end: text.length });
    }
    const ranges = [];
    for (const record of records) {
      if (!record?.text) continue;
      const anchoredStart = nodeAtPath(record.startPath);
      const anchoredEnd = nodeAtPath(record.endPath);
      if (anchoredStart && anchoredEnd && Number.isInteger(record.startOffset) && Number.isInteger(record.endOffset)) {
        try {
          const anchoredRange = new Range();
          anchoredRange.setStart(anchoredStart, record.startOffset);
          anchoredRange.setEnd(anchoredEnd, record.endOffset);
          if (anchoredRange.toString() === record.text) {
            ranges.push(anchoredRange);
            continue;
          }
        } catch { /* The page changed; use the saved text and context below. */ }
      }
      let from = 0;
      while ((from = text.indexOf(record.text, from)) !== -1) {
        const prefix = typeof record.prefix === "string" ? record.prefix : "";
        const suffix = typeof record.suffix === "string" ? record.suffix : "";
        const before = text.slice(Math.max(0, from - prefix.length), from);
        const after = text.slice(from + record.text.length, from + record.text.length + suffix.length);
        if (before.endsWith(prefix) && after.startsWith(suffix)) {
          const first = spans.find(span => span.start <= from && span.end > from);
          const lastOffset = from + record.text.length;
          const last = spans.find(span => span.start < lastOffset && span.end >= lastOffset);
          if (first && last) {
            const range = new Range();
            range.setStart(first.node, from - first.start);
            range.setEnd(last.node, lastOffset - last.start);
            ranges.push(range);
            break;
          }
        }
        from += Math.max(1, record.text.length);
      }
    }
    return ranges;
  }

  async function render() {
    try {
      const result = await chrome.storage.local.get(pageKey);
      const records = Array.isArray(result[pageKey]) ? result[pageKey] : [];
      CSS.highlights?.set(HIGHLIGHT_NAME, new Highlight(...buildRanges(records)));
    } catch { /* Storage may be unavailable on restricted pages. */ }
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 250);
  }

  globalThis.productivityModules?.register("text-highlights", () => {
    const style = document.createElement("style");
    style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: ${COLOR}; color: inherit; }`;
    (document.documentElement || document).append(style);
    const saveSelection = async () => {
      const selection = window.getSelection();
      const text = selection?.toString();
      if (!text?.trim() || selection.isCollapsed) return false;
      const range = selection.getRangeAt(0);
      const prefix = (range.startContainer.textContent || "").slice(Math.max(0, range.startOffset - 32), range.startOffset);
      const suffix = (range.endContainer.textContent || "").slice(range.endOffset, range.endOffset + 32);
      const result = await chrome.storage.local.get(pageKey);
      const records = Array.isArray(result[pageKey]) ? result[pageKey] : [];
      records.push({
        text,
        prefix: prefix.slice(-32),
        suffix: suffix.slice(0, 32),
        startPath: nodePath(range.startContainer),
        endPath: nodePath(range.endContainer),
        startOffset: range.startOffset,
        endOffset: range.endOffset
      });
      await chrome.storage.local.set({ [pageKey]: records });
      selection.removeAllRanges();
      scheduleRender();
      return true;
    };
    const onMessage = (message, _sender, sendResponse) => {
      if (message?.type !== "text-highlights:save-selection") return;
      saveSelection().then(saved => sendResponse({ saved })).catch(() => sendResponse({ saved: false }));
      return true;
    };
    const onStorage = (changes, area) => {
      if (area === "local" && changes[pageKey]) scheduleRender();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorage);
    const observer = new MutationObserver(scheduleRender);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    void render();
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorage);
      observer.disconnect();
      CSS.highlights?.delete(HIGHLIGHT_NAME);
      style.remove();
    };
  });
})();
