const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const source = read("content/code-wrap.js");

const defaults = (() => {
  const context = { globalThis: {} };
  vm.runInNewContext(read("shared/module-defaults.js"), context);
  return context.globalThis.productivityModuleDefaults;
})();

test("the module is wired in and waits to be switched on", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const group = manifest.content_scripts.find(entry => entry.js.includes("content/code-wrap.js"));
  assert.ok(group, "content/code-wrap.js must be declared");
  assert.deepEqual(group.matches, ["<all_urls>"]);
  assert.equal(group.run_at, "document_start");
  // The defaults answer for an unset switch, so they have to be in place before the
  // registry that reads them, which in turn has to precede the module it starts.
  assert.ok(group.js.indexOf("shared/module-defaults.js") < group.js.indexOf("content/module-settings.js"));
  assert.ok(group.js.indexOf("content/module-settings.js") < group.js.indexOf("content/code-wrap.js"));

  const popupHtml = read("popup/popup.html");
  assert.ok(popupHtml.indexOf("shared/module-defaults.js") < popupHtml.indexOf("popup.js"));
  assert.match(read("popup/popup.js"), /\["code-wrap", "Code block wrapping",/);

  // Off until asked for: a button of ours on top of every page's code blocks is not a
  // default anyone chose, so an absent setting reads as "no" rather than "yes".
  assert.equal(defaults.optIn.includes("code-wrap"), true);
  assert.equal(defaults.isEnabled("code-wrap", undefined), false);
  assert.equal(defaults.isEnabled("code-wrap", true), true);
  assert.equal(defaults.isEnabled("csv-viewer", undefined), true, "the other modules keep their default");
});

test("the registry leaves the module off until the setting says otherwise", async () => {
  const started = [];
  const context = {
    chrome: { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}) } } }
  };
  context.globalThis = context;
  vm.runInNewContext(read("shared/module-defaults.js"), context);
  vm.runInNewContext(read("content/module-settings.js"), context);
  context.productivityModules.register("code-wrap", () => { started.push("code-wrap"); return () => {}; });
  context.productivityModules.register("dark-mode", () => { started.push("dark-mode"); return () => {}; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["dark-mode"]);
});

// A stand-in for the handful of DOM behaviours the module uses: a tree it can walk, boxes
// that can be told they overflow, and inline styles it can read back.
function style() {
  const values = new Map();
  const priorities = new Map();
  const api = {
    setProperty(name, value, priority = "") { values.set(name, value); priorities.set(name, priority); },
    removeProperty(name) { values.delete(name); priorities.delete(name); },
    getPropertyPriority: name => priorities.get(name) ?? ""
  };
  for (const name of ["position", "transform"]) {
    Object.defineProperty(api, name, {
      get: () => values.get(name) ?? "",
      set: value => api.setProperty(name, value)
    });
  }
  return api;
}

function node(tag, { className = "", width = 100, content = 100 } = {}) {
  const self = {
    tagName: tag.toUpperCase(),
    className,
    children: [],
    parentNode: null,
    attributes: new Map(),
    listeners: new Map(),
    style: style(),
    clientWidth: width,
    scrollWidth: content,
    scrollLeft: 0,
    scrollTop: 0,
    get textContent() { return self.children.map(child => child.textContent).join(""); },
    appendChild(child) {
      child.parentNode = self;
      self.children.push(child);
      return child;
    },
    remove() {
      self.parentNode?.children.splice(self.parentNode.children.indexOf(self), 1);
      self.parentNode = null;
    },
    setAttribute(name, value) { self.attributes.set(name, String(value)); },
    getAttribute(name) { return self.attributes.get(name) ?? null; },
    removeAttribute(name) { self.attributes.delete(name); },
    hasAttribute(name) { return self.attributes.has(name); },
    addEventListener(name, handler) {
      if (!self.listeners.has(name)) self.listeners.set(name, []);
      self.listeners.get(name).push(handler);
    },
    removeEventListener(name, handler) {
      const handlers = self.listeners.get(name) ?? [];
      const at = handlers.indexOf(handler);
      if (at >= 0) handlers.splice(at, 1);
    },
    dispatch(name) {
      for (const handler of [...(self.listeners.get(name) ?? [])]) {
        handler({ type: name, target: self, preventDefault() {}, stopPropagation() {} });
      }
    },
    descendants() {
      return self.children.flatMap(child => [child, ...child.descendants()]);
    },
    querySelectorAll(selector) {
      const tags = selector.split(",").map(part => part.trim().toUpperCase());
      return self.descendants().filter(child => tags.includes(child.tagName));
    },
    closest(selector) {
      const name = selector.replace(".", "");
      for (let at = self; at; at = at.parentNode) if (at.className.split(" ").includes(name)) return at;
      return null;
    }
  };
  return self;
}

function page() {
  const root = node("html");
  const head = node("head");
  root.appendChild(head);
  let frame;
  let start;
  let notify;
  const context = vm.createContext({
    productivityModules: { register(id, callback) {
      assert.equal(id, "code-wrap");
      start = callback;
    } },
    document: {
      documentElement: root,
      head,
      createElement: tag => node(tag),
      createElementNS: (namespace, tag) => node(tag),
      querySelectorAll: selector => root.querySelectorAll(selector)
    },
    getComputedStyle: element => ({ position: element.style.position || "static" }),
    requestAnimationFrame: callback => { frame = callback; },
    MutationObserver: class {
      constructor(callback) { notify = callback; }
      observe() {}
      disconnect() { notify = undefined; }
    },
    window: { addEventListener() {}, removeEventListener() {} },
    console
  });
  vm.runInContext(source, context);
  const stop = start();
  return {
    root,
    head,
    stop,
    // One pass over a changed page: the observer notices, and the frame it asks for runs.
    tick: () => {
      notify?.();
      const pending = frame;
      frame = undefined;
      pending?.();
    },
    button: block => block.children.find(child => child.className === "productivity-code-wrap-button")
  };
}

// 240 units of code in a 100-unit box: lines running off the right edge, which is the only
// case the button is offered for.
const wide = (tag = "pre") => node(tag, { width: 100, content: 240 });

test("only the blocks that run off the edge get a button, in their own corner", () => {
  const view = page();
  const overflowing = wide();
  const fitting = node("pre");
  // The theme that scrolls an inner <code> rather than the <pre> itself: the block is still
  // the one with the corner, because it is the box that holds still.
  const outer = node("pre");
  const inner = wide("code");
  outer.appendChild(inner);
  for (const block of [overflowing, fitting, outer]) view.root.appendChild(block);
  view.tick();

  assert.ok(view.button(overflowing), "a block with lines off the edge is offered the switch");
  assert.equal(view.button(fitting), undefined, "a block that fits is left alone");
  assert.equal(overflowing.getAttribute("data-productivity-wrap"), "off");
  assert.equal(fitting.hasAttribute("data-productivity-wrap"), false);
  assert.ok(view.button(outer), "the button hangs on the block, not on the scrolling child");
  assert.equal(view.button(inner), undefined);
  // A static block cannot measure a corner, so it is made the containing block.
  assert.equal(overflowing.style.position, "relative");

  const button = view.button(overflowing);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.getAttribute("aria-label"), "Wrap long lines");
  // The label lives in aria-label, never in a text node: a theme's "copy" button reads the
  // block's textContent, and a word of ours in there would be copied along with the code.
  assert.equal(button.textContent, "");
  assert.equal(overflowing.textContent, "");
});

test("the switch wraps the block it belongs to, and unwraps it again", () => {
  const view = page();
  const block = wide();
  view.root.appendChild(block);
  view.tick();
  const button = view.button(block);

  button.dispatch("click");
  assert.equal(block.getAttribute("data-productivity-wrap"), "on");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.getAttribute("aria-label"), "Stop wrapping long lines");

  // Wrapped, the block no longer overflows - so a later pass must not read that as a block
  // with nothing to offer and take away the only way back.
  block.scrollWidth = block.clientWidth;
  view.tick();
  assert.equal(view.button(block), button);
  assert.equal(block.getAttribute("data-productivity-wrap"), "on");

  button.dispatch("click");
  assert.equal(block.getAttribute("data-productivity-wrap"), "off");
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

test("the button holds its corner while the block scrolls sideways", () => {
  const view = page();
  const block = wide();
  view.root.appendChild(block);
  view.tick();
  const button = view.button(block);
  assert.equal(button.style.transform, "translate(0px, 0px)");

  block.scrollLeft = 85;
  block.dispatch("scroll");
  assert.equal(button.style.transform, "translate(85px, 0px)");

  // Wrapping leaves nothing to scroll, and the corner moves back with it.
  block.scrollLeft = 0;
  button.dispatch("click");
  assert.equal(button.style.transform, "translate(0px, 0px)");
});

test("a block that stops overflowing, or leaves the page, gives its corner back", () => {
  const view = page();
  const block = wide();
  block.style.position = "sticky";
  const leaving = wide();
  view.root.appendChild(block);
  view.root.appendChild(leaving);
  view.tick();
  assert.ok(view.button(block));
  // An inline position of the page's own is read, not replaced.
  assert.equal(block.style.position, "sticky");

  // The window was widened until the lines fit.
  block.scrollWidth = block.clientWidth;
  leaving.remove();
  view.tick();
  assert.equal(view.button(block), undefined);
  assert.equal(block.hasAttribute("data-productivity-wrap"), false);
  assert.equal(block.style.position, "sticky");
  assert.equal(view.button(leaving), undefined, "a block removed from the page is let go of");
});

test("the CSV viewer's raw-text pane keeps its own reader", () => {
  const view = page();
  const host = node("div", { className: "pcsv-host" });
  const block = wide();
  host.appendChild(block);
  view.root.appendChild(host);
  view.tick();
  assert.equal(view.button(block), undefined);
  assert.equal(block.hasAttribute("data-productivity-wrap"), false);
});

test("switching the module off puts every block back", () => {
  const view = page();
  const plain = wide();
  const positioned = wide();
  positioned.style.position = "absolute";
  view.root.appendChild(plain);
  view.root.appendChild(positioned);
  view.tick();
  view.button(plain).dispatch("click");
  assert.equal(view.head.children.some(child => child.tagName === "STYLE"), true);

  view.stop();
  for (const block of [plain, positioned]) {
    assert.equal(view.button(block), undefined);
    assert.equal(block.hasAttribute("data-productivity-wrap"), false);
    assert.equal(block.listeners.get("scroll").length, 0, "the pin is unsubscribed");
  }
  assert.equal(plain.style.position, "", "the position we added is taken back off");
  assert.equal(positioned.style.position, "absolute", "the page's own position is left as it was");
  assert.equal(view.head.children.some(child => child.tagName === "STYLE"), false);
});
