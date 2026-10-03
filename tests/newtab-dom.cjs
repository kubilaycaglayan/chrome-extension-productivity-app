// Shared DOM stand-in for the New Tab page tests: enough tree, events,
// dialogs, drag payloads and layout boxes for the page to run under node.
const fs = require("node:fs");
const vm = require("node:vm");

const PAGE_IDS = [
  "app", "search-area", "search", "query", "suggestions", "tab-groups", "groups", "new-group", "new-group-name", "add-group", "drag-hint",
  "import-bookmarks", "group-actions", "attribution", "edit-toggle", "extensions-toggle", "background-panel", "background-toggle", "background-message",
  "color-swatches", "gradient-swatches", "wallpaper-section", "wallpaper-collections",
  "wallpaper-images", "wallpaper-back", "background-image", "background-reset",
  "group-dialog", "group-form", "group-name", "group-dialog-title", "group-cancel",
  "bookmark-dialog", "bookmark-form", "bookmark-search", "bookmark-suggestions",
  "bookmark-label", "bookmark-url", "bookmark-error", "bookmark-dialog-title", "bookmark-cancel",
  "status", "notice"
];

function camel(name) {
  return name.replace(/^data-/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function matches(node, selector) {
  if (selector.startsWith(".")) return node.className.split(" ").includes(selector.slice(1));
  const attribute = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
  if (attribute) {
    const [, name, value] = attribute;
    const held = node.getAttribute(name) ?? node.dataset[camel(name)];
    return value === undefined ? held !== undefined : held === value;
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function descendants(node, selector, found) {
  for (const kid of node.children) {
    if (matches(kid, selector)) found.push(kid);
    descendants(kid, selector, found);
  }
  return found;
}

function queryAll(root, selector) {
  let current = [root];
  for (const part of selector.trim().split(/\s+/)) {
    const next = [];
    for (const node of current) descendants(node, part, next);
    current = next;
  }
  return current;
}

function fire(node, name, event = {}) {
  let stopped = false;
  const payload = {
    type: name,
    target: node,
    preventDefault() { payload.defaultPrevented = true; },
    stopPropagation() { stopped = true; },
    defaultPrevented: false,
    ...event
  };
  for (const handler of [...(node.listeners.get(name) ?? [])]) handler(payload);
  if (!stopped && node.parentNode) fire(node.parentNode, name, { ...event, target: event.target ?? node });
  return payload;
}

function makeElement(tag, id = "") {
  const node = {
    tagName: tag.toUpperCase(),
    id,
    children: [],
    parentNode: null,
    listeners: new Map(),
    attributes: {},
    dataset: {},
    style: {},
    className: "",
    textContent: "",
    value: "",
    files: [],
    hidden: false,
    open: false,
    offsetTop: 0,
    scrollTop: 0,
    returnValue: "",
    rect: { left: 0, top: 0, width: 200, height: 40 },
    classList: {
      names: new Set(),
      add(name) { this.names.add(name); },
      remove(name) { this.names.delete(name); },
      toggle(name, on) { if (on) this.names.add(name); else this.names.delete(name); },
      contains(name) { return this.names.has(name); }
    },
    append(...kids) {
      for (const kid of kids) {
        kid.parentNode = node;
        node.children.push(kid);
      }
    },
    replaceChildren(...kids) {
      for (const kid of node.children) kid.parentNode = null;
      node.children = [];
      node.append(...kids);
    },
    replaceWith(next) {
      const parent = node.parentNode;
      if (!parent) return;
      parent.children[parent.children.indexOf(node)] = next;
      next.parentNode = parent;
    },
    remove() {
      node.parentNode?.children.splice(node.parentNode.children.indexOf(node), 1);
      node.parentNode = null;
    },
    addEventListener(name, handler) {
      if (!node.listeners.has(name)) node.listeners.set(name, new Set());
      node.listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) { node.listeners.get(name)?.delete(handler); },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute(name) { return node.attributes[name] ?? null; },
    removeAttribute(name) { delete node.attributes[name]; },
    matches(selector) { return selector.split(",").some(part => matches(node, part.trim())); },
    focus() { node.focused = true; },
    contains(other) { return other === node || node.children.some(kid => kid.contains(other)); },
    showModal() { node.open = true; },
    close() {
      if (!node.open) return;
      node.open = false;
      for (const handler of [...(node.listeners.get("close") ?? [])]) handler({ target: node });
    },
    getBoundingClientRect() { return node.rect; },
    querySelectorAll(selector) { return queryAll(node, selector); },
    querySelector(selector) { return queryAll(node, selector)[0] ?? null; }
  };
  return node;
}

function dataTransfer() {
  const data = {};
  return {
    data,
    types: [],
    effectAllowed: "",
    dropEffect: "",
    setData(type, value) { data[type] = String(value); this.types.push(type); },
    getData(type) { return data[type] ?? ""; },
    setDragImage() {}
  };
}

// Builds a page whose chrome.* and network calls are all observable.
function setup({ stored = {}, bookmarks = [], tree = [], topSites = [], tabs = {}, browserGroups = null, browserTabs = null, responses = {}, scripts } = {}) {
  const store = JSON.parse(JSON.stringify(stored));
  const writes = [];
  const storageListeners = new Set();
  const navigations = [];
  const tabUpdates = [];
  const tabOpens = [];
  const tabGroupUpdates = [];
  const tabGroupEvents = Object.fromEntries(["onCreated", "onUpdated", "onMoved", "onRemoved"].map(name => {
    const listeners = new Set();
    return [name, {
      listeners,
      addListener(handler) { listeners.add(handler); },
      removeListener(handler) { listeners.delete(handler); },
      fire() { for (const handler of listeners) handler(); }
    }];
  }));
  const fetches = [];
  const timers = new Map();
  let nextTimer = 0;
  let lastCanvas = null;
  let pageHasFocus = true;

  const elements = new Map(PAGE_IDS.map(id => [id, makeElement(id.endsWith("dialog") ? "dialog" : "div", id)]));
  elements.get("background-panel").append(
    elements.get("color-swatches"),
    elements.get("gradient-swatches"),
    elements.get("wallpaper-collections"),
    elements.get("wallpaper-images"),
    elements.get("wallpaper-back"),
    elements.get("background-message")
  );
  elements.get("search-area").append(elements.get("search"), elements.get("suggestions"));
  elements.get("search").append(elements.get("query"));
  elements.get("app").hidden = true;
  elements.get("background-panel").hidden = true;
  elements.get("suggestions").hidden = true;
  elements.get("bookmark-suggestions").hidden = true;
  elements.get("attribution").hidden = true;
  elements.get("extensions-toggle").hidden = true;
  const body = makeElement("body");

  const document = {
    body,
    documentElement: makeElement("html"),
    hasFocus: () => pageHasFocus,
    getElementById: id => elements.get(id) ?? null,
    createElement(tag) {
      const node = makeElement(tag);
      if (tag === "canvas") {
        node.getContext = () => ({ drawImage() {} });
        node.toDataURL = () => `data:image/jpeg;base64,${"A".repeat(64)}`;
        lastCanvas = node;
      }
      return node;
    },
    addEventListener(name, handler) { body.addEventListener(name, handler); },
    removeEventListener(name, handler) { body.removeEventListener(name, handler); }
  };

  const context = vm.createContext({
    document,
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    screen: { width: 1280, height: 800 },
    devicePixelRatio: 2,
    location: { assign: url => navigations.push(url) },
    fetch(url, options) {
      fetches.push({ url, options });
      const reply = typeof responses[url] === "function" ? responses[url](options) : responses[url];
      if (reply === undefined) return Promise.reject(new Error("offline"));
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(typeof reply === "string" ? reply : ""),
        arrayBuffer: () => Promise.resolve(reply instanceof Uint8Array ? reply.buffer : new ArrayBuffer(0))
      });
    },
    createImageBitmap: () => Promise.resolve({ width: 4000, height: 3000, close() {} }),
    setTimeout(handler) { timers.set(++nextTimer, handler); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      runtime: { getURL: path => `chrome-extension://productivity/${path}` },
      i18n: { getUILanguage: () => "en-GB" },
      // null stands for "this browser has no such API".
      bookmarks: tree === null ? undefined : { search: () => Promise.resolve(bookmarks), getTree: () => Promise.resolve(tree) },
      topSites: topSites === null ? undefined : { get: () => Promise.resolve(topSites) },
      tabGroups: browserGroups === null ? undefined : {
        query: () => Promise.resolve(browserGroups),
        update(groupId, changes) {
          tabGroupUpdates.push({ groupId, changes });
          return Promise.resolve();
        },
        ...tabGroupEvents
      },
      tabs: tabs === null ? undefined : {
        getCurrent: browserTabs === null ? undefined : () => Promise.resolve({ windowId: 1 }),
        query: browserTabs === null ? undefined : () => Promise.resolve(browserTabs),
        update(target) {
          const url = typeof target === "number" ? target : target.url;
          tabUpdates.push(url);
          // Chrome can refuse a navigation; `refuseUpdate` exercises that path.
          return tabs.refuseUpdate ? Promise.reject(new Error("blocked")) : Promise.resolve({ url });
        },
        create({ url }) {
          tabOpens.push(url);
          return Promise.resolve({ url });
        }
      },
      storage: {
        local: {
          get(keys) {
            const wanted = Array.isArray(keys) ? keys : [keys];
            return Promise.resolve(Object.fromEntries(wanted.filter(key => key in store).map(key => [key, store[key]])));
          },
          set(values) {
            writes.push(values);
            Object.assign(store, JSON.parse(JSON.stringify(values)));
            return Promise.resolve();
          }
        },
        onChanged: {
          addListener: handler => storageListeners.add(handler),
          removeListener: handler => storageListeners.delete(handler)
        }
      }
    }
  });
  context.globalThis = context;

  for (const file of scripts ?? ["content/module-settings.js", "shared/newtab-settings.js", "shared/newtab-wallpapers.js", "newtab/newtab.js"]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context);
  }

  return {
    context,
    element: id => elements.get(id),
    body,
    store,
    writes,
    navigations,
    tabUpdates,
    tabOpens,
    tabGroupUpdates,
    tabGroupEvents,
    fetches,
    settings: context.newtabSettings,
    wallpapers: context.newtabWallpapers,
    get lastCanvas() { return lastCanvas; },
    set pageHasFocus(value) { pageHasFocus = value; },
    cards: () => elements.get("groups").children,
    groupNames: () => elements.get("groups").children.map(card => queryAll(card, ".group-name")[0].textContent),
    tiles: index => queryAll(elements.get("groups").children[index], ".tile"),
    // Scoped to real tiles so the trailing "Add" tile is not counted.
    tileLabels: index => queryAll(elements.get("groups").children[index], ".tile .label").map(node => node.textContent),
    status: () => elements.get("status").textContent,
    swatches: () => queryAll(elements.get("background-panel"), ".swatch"),
    options: id => elements.get(id).children,
    toggleModule(enabled) {
      store["moduleEnabled:newtab"] = enabled;
      for (const handler of storageListeners) handler({ "moduleEnabled:newtab": { newValue: enabled } }, "local");
    },
    storageChange(changes) {
      for (const handler of storageListeners) handler(changes, "local");
    },
    flushTimers() {
      for (const [id, handler] of timers) {
        timers.delete(id);
        handler();
      }
    }
  };
}

// Mimics implicit submission: Enter in a field activates the form's single
// submit button, which for a method="dialog" form closes it with that value.
function pressEnter(dialog, field) {
  if (field) fire(field, "keydown", { key: "Enter" });
  if (!dialog.open) return;
  dialog.returnValue = "save";
  dialog.close();
}

module.exports = { setup, fire, queryAll, dataTransfer, pressEnter, makeElement, settle: () => new Promise(resolve => setImmediate(resolve)) };
