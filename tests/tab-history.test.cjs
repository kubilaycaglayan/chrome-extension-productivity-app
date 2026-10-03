const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function setup(initial = {}) {
  const stored = structuredClone(initial);
  const listeners = {};
  const live = new Set();
  const activations = [];
  const updates = [];
  let active = null;
  let windowId = 1;

  const chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: structuredClone(stored[key]) }; },
        async set(values) { Object.assign(stored, structuredClone(values)); }
      }
    },
    tabs: {
      onActivated: { addListener(listener) { listeners.activate = listener; } },
      onRemoved: { addListener(listener) { listeners.remove = listener; } },
      async query() { return active == null ? [] : [{ id: active, windowId }]; },
      async update(tabId) {
        updates.push(tabId);
        if (!live.has(tabId)) throw new Error("Tab closed");
        active = tabId;
        activations.push(listeners.activate({ tabId, windowId }));
      }
    },
    commands: { onCommand: { addListener(listener) { listeners.command = listener; } } }
  };
  const source = fs.readFileSync("modules/tab-history.js", "utf8")
    .replace('import { isModuleEnabled } from "./settings.js";', "const isModuleEnabled = async () => true;")
    .replace("export function initializeTabHistory", "function initializeTabHistory");
  const context = vm.createContext({ chrome });
  vm.runInContext(`${source}\ninitializeTabHistory();`, context);

  return {
    stored, live, updates,
    get active() { return active; },
    async visit(tabId, nextWindow = 1) {
      windowId = nextWindow;
      live.add(tabId);
      active = tabId;
      await listeners.activate({ tabId, windowId });
    },
    async close(tabId, nextWindow = 1) {
      live.delete(tabId);
      await listeners.remove(tabId, { windowId: nextWindow });
    },
    async toggle() {
      await listeners.command("toggle-last-tab");
      await Promise.all(activations.splice(0));
    }
  };
}

(async () => {
  const page = setup();
  for (const id of [1, 2, 3, 4]) await page.visit(id);
  assert.deepEqual(Array.from(page.stored.windowTabHistory[1]), [4, 3, 2, 1]);

  await page.toggle();
  assert.equal(page.active, 3);
  await page.toggle();
  assert.equal(page.active, 4, "The shortcut still toggles between the latest two tabs");
  assert.deepEqual(page.updates, [3, 4]);

  await page.close(3);
  await page.toggle();
  assert.equal(page.active, 2, "Closing the previous tab exposes the next earlier visit");
  await page.toggle();
  assert.equal(page.active, 4, "The fallback becomes the new two-tab pair");

  // A removed tab can still be in session storage if its close event was
  // missed. A failed activation should continue to the next live candidate.
  page.live.delete(2);
  await page.toggle();
  assert.equal(page.active, 1);
  assert.deepEqual(Array.from(page.stored.windowTabHistory[1]), [1, 4]);

  const migrated = setup({ windowTabHistory: { 1: { current: 8, previous: 7 } } });
  await migrated.visit(8);
  migrated.live.add(7);
  await migrated.toggle();
  assert.equal(migrated.active, 7, "The old current/previous history remains usable");

  const bounded = setup();
  for (let id = 1; id <= 25; id++) await bounded.visit(id);
  assert.equal(bounded.stored.windowTabHistory[1].length, 20);
  assert.deepEqual(Array.from(bounded.stored.windowTabHistory[1]).slice(0, 2), [25, 24]);
  assert.equal(bounded.stored.windowTabHistory[1].at(-1), 6);

  console.log("PASS tab history: two-tab toggle, close fallback, stale tabs, migration, bounded queue");
})().catch(error => { console.error(error); process.exitCode = 1; });
