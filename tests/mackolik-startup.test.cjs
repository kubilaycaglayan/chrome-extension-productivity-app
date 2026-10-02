const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function setup(readyState) {
  let videoConnected = true;
  let cleanup;
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const outer = { tagName: "DIV", parentNode: {}, before() {}, remove() { videoConnected = false; } };
  const video = { parentElement: { parentElement: { parentElement: outer } } };
  const context = vm.createContext({
    document: {
      readyState,
      documentElement: { appendChild() {} },
      createElement: () => ({ appendChild() {}, setAttribute() {}, style: { setProperty() {} }, remove() {} }),
      createComment: () => ({ replaceWith() { videoConnected = true; } }),
      getElementById: id => id === "featured-video" && videoConnected ? video : null,
      querySelectorAll: () => [],
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: name => listeners.delete(name)
    },
    productivityModules: { register(id, start) { cleanup = start(); } },
    chrome: { storage: { local: { get: () => new Promise(() => {}) }, onChanged: { addListener() {}, removeListener() {} } } },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  });
  for (const file of ["shared/mackolik-settings.js", "content/mackolik-priority-rows.js", "content/mackolik-featured-video.js"]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context);
  }
  return {
    connected: () => videoConnected,
    ready() { listeners.get("DOMContentLoaded")?.(); },
    flush() { for (const [id, fn] of timers) { timers.delete(id); fn(); } },
    cleanup: () => cleanup()
  };
}

for (const state of ["loading", "interactive", "complete"]) {
  const page = setup(state);
  assert.ok(page.connected(), `${state}: startup video must remain available`);
  page.ready();
  // Later DOMContentLoaded/jQuery callbacks still need the original element.
  assert.ok(page.connected(), `${state}: cleanup must wait for the next task`);
  page.flush();
  assert.equal(page.connected(), false, `${state}: video is removed after startup`);
  page.cleanup();
  assert.ok(page.connected(), `${state}: disabling restores the original video`);
}
const disabled = setup("loading");
disabled.ready();
disabled.cleanup();
disabled.flush();
assert.ok(disabled.connected(), "Disabling before startup cancels pending removal");
console.log("PASS startup timing for loading/interactive/complete, restoration, and pending-start cancellation");
