// Shared DOM stand-in for the popup tests. popup.js is one long top-level script written
// against a popup that is already in the DOM, so testing it means supplying that DOM.
// Elements are minted on demand by id, which keeps this to the handful of behaviours the
// script actually uses rather than a second implementation of the document.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");

function element() {
  const self = {
    className: "", title: "", id: "", value: "", hidden: false, disabled: false, checked: false,
    children: [], attributes: {}, listeners: new Map(), dataset: {}, text: "",
    get textContent() {
      return self.children.length ? self.children.map(child => child.textContent).join("") : self.text;
    },
    set textContent(value) { self.children = []; self.text = String(value); },
    append(...kids) { self.children.push(...kids); self.text = ""; },
    appendChild(kid) { self.append(kid); return kid; },
    prepend(kid) { self.children.unshift(kid); },
    replaceChildren(...kids) { self.children = [...kids]; self.text = ""; },
    remove() {},
    setAttribute(name, value) { self.attributes[name] = String(value); },
    getAttribute(name) { return self.attributes[name] ?? null; },
    addEventListener(name, handler) {
      if (!self.listeners.has(name)) self.listeners.set(name, []);
      self.listeners.get(name).push(handler);
    },
    dispatch(name) {
      for (const handler of self.listeners.get(name) ?? []) handler({ type: name, target: self, preventDefault() {} });
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }
  };
  return self;
}

// Stands in for the half of the ad blocker that lives in the service worker: it keeps the
// paused list, normalizes it the way `cleanPausedSites` does, and can be told to refuse a
// write. What the real worker does with that list -- the DNR rules and the cosmetic
// registration -- is tests/ad-blocker.test.cjs's business, not the popup's.
function adBlockerWorker(initial = []) {
  const worker = {
    sites: [...initial],
    enabled: true,
    extraEnabled: true,
    refuse: null,
    handle: async message => {
      if (message.type === "ad-blocker:get") {
        return { ok: true, enabled: worker.enabled, extraEnabled: worker.extraEnabled, sites: [...worker.sites] };
      }
      if (message.type === "ad-blocker:set-sites") {
        if (worker.refuse) return { ok: false, error: worker.refuse };
        worker.sites = [...new Set(message.sites.map(site => site.trim().toLowerCase()).filter(Boolean))];
        return { ok: true, sites: [...worker.sites] };
      }
      if (message.type === "ad-blocker:set-enabled") {
        worker.enabled = message.enabled;
        return { ok: true, enabled: worker.enabled, extraEnabled: worker.extraEnabled };
      }
      return { ok: true };
    }
  };
  return worker;
}

function popupPage({
  headings = [],
  stored = {},
  tab = { id: 7, url: "https://example.com/" },
  reachable = true,
  sendMessage = async () => ({ ok: true, enabled: true, extraEnabled: true, sites: [] })
} = {}) {
  const nodes = new Map();
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, Object.assign(element(), { id }));
    return nodes.get(id);
  };
  // The popup opens on the outline, exactly as popup.html ships it.
  byId("settings-view").hidden = true;

  const changeListeners = [];
  const document_ = {
    body: element(),
    activeElement: null,
    getElementById: byId,
    createElement: element,
    addEventListener() {},
    removeEventListener() {}
  };
  const context = vm.createContext({
    document: document_,
    // Both personal lists live in gitignored files that a test profile does not have, and
    // the popup is written to prefill nothing when the fetch fails.
    fetch: async () => { throw new Error("no local list"); },
    URL,
    chrome: {
      tabs: { query: async () => (tab ? [tab] : []) },
      storage: {
        local: { get: async () => ({ ...stored }), set: async () => {} },
        onChanged: { addListener: listener => changeListeners.push(listener) }
      },
      scripting: {
        executeScript: async () => {
          if (!reachable) throw new Error("cannot access this page");
          return [{ result: headings }];
        }
      },
      runtime: { getURL: file => file, sendMessage }
    },
    console
  });
  for (const file of ["module-defaults", "mackolik-settings", "newtab-settings", "x-keywords", "cookie-accepter-settings"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "shared", `${file}.js`), "utf8"), context);
  }
  vm.runInContext(source, context);
  return {
    byId,
    document: document_,
    get showing() {
      if (!byId("outline-view").hidden) return "outline";
      return byId("settings-view").hidden ? "neither" : "settings";
    },
    // What a change made in another window -- or by the worker itself -- looks like from in
    // here. The popup has to follow storage it did not write.
    changed: (changes, area = "local") => { for (const listener of changeListeners) listener(changes, area); },
    // Every stand-in promise is already resolved, so one turn of the event loop drains the
    // whole chain the popup kicked off at load.
    settle: () => new Promise(resolve => setImmediate(resolve))
  };
}

module.exports = { popupPage, adBlockerWorker, source };
