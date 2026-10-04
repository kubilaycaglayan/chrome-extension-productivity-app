const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const articles = [
  { textContent: "A normal post", attributes: new Set() },
  { textContent: "Sample listing", attributes: new Set() },
  { textContent: "A phrase to block", attributes: new Set() }
];
for (const article of articles) {
  article.setAttribute = name => article.attributes.add(name);
  article.removeAttribute = name => article.attributes.delete(name);
}

const listeners = new Set();
let start;
let style;
const context = vm.createContext({
  productivityModules: { register(id, callback) {
    assert.equal(id, "x-keyword-filter");
    start = callback;
  } },
  chrome: {
    storage: {
      local: { get: async () => ({}) },
      onChanged: {
        addListener: listener => listeners.add(listener),
        removeListener: listener => listeners.delete(listener)
      }
    }
  },
  document: {
    createElement: () => style = { textContent: "", remove() { this.removed = true; } },
    head: { appendChild() {} },
    documentElement: {},
    querySelectorAll: selector => selector === "article"
      ? articles
      : articles.filter(article => article.attributes.has("data-productivity-keyword-hidden"))
  },
  MutationObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: callback => callback(),
  console
});

vm.runInContext(fs.readFileSync("shared/x-keywords.js", "utf8"), context);
vm.runInContext(fs.readFileSync("content/x-keyword-filter.js", "utf8"), context);
assert.deepEqual(Array.from(context.xKeywords.clean([" Sample ", "sample", "", "  phrase  "])), ["Sample", "phrase"]);

(async () => {
  const cleanup = start();
  await new Promise(resolve => setImmediate(resolve));
  const hidden = article => article.attributes.has("data-productivity-keyword-hidden");
  assert.equal(hidden(articles[1]), false, "No posts are hidden before words are configured");
  assert.equal(hidden(articles[0]), false);

  for (const listener of listeners) listener({ xBlockedWords: { newValue: ["sample", "phrase to block"] } }, "local");
  assert.equal(hidden(articles[1]), true, "Adding a word hides matching posts");
  assert.equal(hidden(articles[2]), true, "Adding a phrase hides matching posts");

  for (const listener of listeners) listener({ xBlockedWords: { newValue: [] } }, "local");
  assert.equal(hidden(articles[2]), false, "An empty list stops filtering");

  cleanup();
  assert.equal(listeners.size, 0);
  assert.equal(style.removed, true);
  console.log("PASS X keyword filter: default, live edits, clearing, cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
