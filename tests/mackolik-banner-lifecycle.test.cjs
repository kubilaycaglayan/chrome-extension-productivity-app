const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Regression: a full score render inserts placeholders and immediately accesses
// the existing banner containers, before any MutationObserver can run.
const containers = [1, 2, 3].map(number => ({
  id: `bannerContainer${number}`,
  style: {},
  connected: true,
  before() {},
  remove() { this.connected = false; }
}));
const placeholders = new Map();
let cleanup;
const style = { remove() {} };
const context = vm.createContext({
  document: {
    readyState: "complete",
    documentElement: { appendChild() {} },
    createElement: tag => tag === "style" ? style : { appendChild() {}, setAttribute() {}, style: { setProperty() {} }, remove() {} },
    createComment: () => ({ replaceWith(node) { node.connected = true; } }),
    getElementById: id => containers.find(node => node.connected && node.id === id) || placeholders.get(id) || null,
    querySelectorAll: selector => selector.includes('[id^="bannerContainer"]') ? containers.filter(node => node.connected) : [],
    addEventListener() {}, removeEventListener() {}
  },
  productivityModules: { register(id, start) { cleanup = start(); } },
  chrome: { storage: { local: { get: () => new Promise(() => {}) }, onChanged: { addListener() {}, removeListener() {} } } },
  MutationObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  setTimeout: fn => { fn(); return 0; },
  clearTimeout() {}
});
for (const file of ["shared/mackolik-settings.js", "content/mackolik-priority-rows.js", "content/mackolik-featured-video.js"]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
}
for (let update = 0; update < 5; update++) {
  for (let number = 1; number <= 3; number++) {
    placeholders.set(`bannerPlaceHolder${number}`, {});
    // The site's writeBanner() assumes these exist whenever a placeholder does.
    const banner = context.document.getElementById(`bannerContainer${number}`);
    assert.ok(banner, `Required banner container ${number} must survive cleanup`);
    banner.style.left = "0px";
    banner.style.top = "0px";
    banner.style.display = "block";
  }
}
assert.match(style.textContent, /\[id\^="bannerContainer"\][^{]*\{\s*display:\s*none\s*!important/);
assert.match(style.textContent, /#live-score-righttemp[^{]*\{\s*display:\s*none\s*!important/);
cleanup();
assert.ok(containers.every(node => node.connected));
console.log("PASS required banner containers survive repeated renders and remain hidden over inline display:block");
