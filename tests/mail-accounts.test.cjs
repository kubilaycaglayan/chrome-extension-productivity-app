const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Discovering which Google accounts a profile is signed into. There is no API
// for it, so the worker reads the index out of Gmail URLs the browser loads
// and, at most twice a day, asks Gmail where each index lands. The page side
// of this is tests/newtab-mail.test.cjs.
const SIGNED_OUT = "https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/u/1/";

function setup({ stored = {}, signedIn = [], offline = false } = {}) {
  const store = structuredClone(stored);
  const listeners = {};
  const fetches = [];

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(wanted.filter(key => key in store).map(key => [key, structuredClone(store[key])]));
        },
        async set(values) { Object.assign(store, structuredClone(values)); }
      }
    },
    runtime: {
      onStartup: { addListener(listener) { listeners.startup = listener; } },
      onInstalled: { addListener(listener) { listeners.installed = listener; } }
    },
    tabs: { onUpdated: { addListener(listener) { listeners.updated = listener; } } }
  };

  const context = vm.createContext({
    chrome,
    URL,
    Set,
    Date,
    Number,
    Array,
    // Gmail keeps a signed-in index on its own URL and bounces one nobody is
    // signed into; `redirect: "follow"` means the page only sees where it
    // ended up, which is `response.url`.
    async fetch(url, options) {
      fetches.push({ url, options });
      if (offline) throw new Error("offline");
      const slot = Number(url.match(/\/mail\/u\/(\d+)\//)[1]);
      return { ok: true, status: 200, url: signedIn.includes(slot) ? url : SIGNED_OUT };
    }
  });
  context.globalThis = context;

  const source = fs.readFileSync("modules/mail-accounts.js", "utf8")
    // The same two lines modules/settings.js exports, inlined.
    .replace('import { isModuleEnabled } from "./settings.js";',
      'const isModuleEnabled = async id => (await chrome.storage.local.get(`moduleEnabled:${id}`))[`moduleEnabled:${id}`] !== false;')
    .replace("export function initializeMailAccounts", "function initializeMailAccounts");
  vm.runInContext(`${source}\ninitializeMailAccounts();`, context);

  return {
    store,
    fetches,
    get accounts() { return store.newtabMailAccounts?.accounts; },
    get checkedAt() { return store.newtabMailAccounts?.checkedAt; },
    probed: () => fetches.map(call => call.url),
    startup: () => listeners.startup(),
    installed: () => listeners.installed({ reason: "update" }),
    visit: url => listeners.updated(7, { url }, { id: 7, url })
  };
}

const day = 24 * 60 * 60 * 1000;

(async () => {
  /* Two accounts signed in: the walk stops at the first index Gmail refuses. */
  const two = setup({ signedIn: [0, 1] });
  await two.startup();
  assert.deepEqual(two.accounts, [0, 1]);
  assert.deepEqual(two.probed(), [
    "https://mail.google.com/mail/u/0/",
    "https://mail.google.com/mail/u/1/",
    "https://mail.google.com/mail/u/2/"
  ], "One request past the last account is what proves it is the last");
  for (const { options } of two.fetches) {
    assert.equal(options.method, "HEAD", "An answer must cost headers, not an inbox");
    assert.equal(options.credentials, "include", "The cookies are the question being asked");
    assert.equal(options.cache, "no-store", "A cached redirect would answer for a session that has changed");
  }
  assert.ok(Date.now() - two.checkedAt < 5000, "The answer is stamped so it can go stale");

  /* A gap is the end of the list, not something to step over: index 2 is never
     asked about once index 1 has been refused. */
  const gap = setup({ signedIn: [0, 2] });
  await gap.startup();
  assert.deepEqual(gap.accounts, [0]);
  assert.deepEqual(gap.probed(), ["https://mail.google.com/mail/u/0/", "https://mail.google.com/mail/u/1/"]);

  /* Signed out of Google altogether is a real answer, and an empty list is
     what the page turns back into its single plain shortcut. */
  const out = setup({ stored: { newtabMailAccounts: { accounts: [0, 1], checkedAt: Date.now() - 2 * day } } });
  await out.startup();
  assert.deepEqual(out.accounts, [], "The probe is authoritative: a signed-out account loses its button");

  /* Offline says nothing rather than reporting an empty list. */
  const offline = setup({ stored: { newtabMailAccounts: { accounts: [0, 1], checkedAt: Date.now() - 2 * day } }, offline: true });
  await offline.startup();
  assert.deepEqual(offline.accounts, [0, 1], "A failed probe must not throw away a list that was right yesterday");
  assert.equal(offline.fetches.length, 1, "There is no point walking the rest once Gmail is unreachable");

  /* A fresh answer is left alone; a stale one is re-asked. */
  const fresh = setup({ stored: { newtabMailAccounts: { accounts: [0], checkedAt: Date.now() - 60_000 } }, signedIn: [0, 1] });
  await fresh.startup();
  assert.equal(fresh.fetches.length, 0, "Twice a day is the budget");
  assert.deepEqual(fresh.accounts, [0]);

  const stale = setup({ stored: { newtabMailAccounts: { accounts: [0], checkedAt: Date.now() - 2 * day } }, signedIn: [0, 1] });
  await stale.startup();
  assert.deepEqual(stale.accounts, [0, 1]);

  /* An update re-asks whatever the stamp says: the stored list may be months
     old, and a fresh install has none at all. */
  const updated = setup({ stored: { newtabMailAccounts: { accounts: [0], checkedAt: Date.now() } }, signedIn: [0, 1] });
  await updated.installed();
  assert.deepEqual(updated.accounts, [0, 1]);

  /* The free half of the discovery: a Gmail tab names its account. */
  const visited = setup({ stored: { newtabMailAccounts: { accounts: [0], checkedAt: Date.now() } }, signedIn: [0, 2] });
  await visited.visit("https://mail.google.com/mail/u/2/#inbox");
  assert.deepEqual(visited.accounts, [0, 2], "A tab on /mail/u/2/ is proof that account 2 exists");
  assert.equal(visited.fetches.length, 0, "A visit inside the budget costs nothing");
  assert.equal(visited.checkedAt, visited.store.newtabMailAccounts.checkedAt, "Watching a tab is not the same as checking");
  await visited.visit("https://mail.google.com/mail/u/2/#sent");
  assert.deepEqual(visited.accounts, [0, 2], "The same account twice is still one button");

  /* ...and only a Gmail account URL counts. */
  const ignored = setup({ stored: { newtabMailAccounts: { accounts: [0], checkedAt: Date.now() } } });
  for (const url of [
    "https://mail.google.com/chat/u/1/",
    "https://mail.google.com/mail/",
    "https://mail.google.com/mail/u/9/",
    "https://mail.google.com.evil.example/mail/u/1/",
    "https://accounts.google.com/AccountChooser",
    "not a url",
    undefined
  ]) {
    await ignored.visit(url);
  }
  assert.deepEqual(ignored.accounts, [0], `${JSON.stringify(ignored.accounts)} must still be the list`);
  assert.equal(ignored.fetches.length, 0);

  /* Nothing happens at all for a profile that has the page switched off. */
  const off = setup({ stored: { "moduleEnabled:newtab": false }, signedIn: [0, 1] });
  await off.startup();
  await off.installed();
  await off.visit("https://mail.google.com/mail/u/1/");
  assert.equal(off.fetches.length, 0, "A page nobody uses must not call Gmail");
  assert.equal(off.accounts, undefined, "...and must not write a list either");

  /* A visit and a probe both read-modify-write the same record, so they have
     to queue rather than overwrite each other. */
  const racing = setup({ stored: { newtabMailAccounts: { accounts: [], checkedAt: Date.now() - 2 * day } }, signedIn: [0, 1] });
  await Promise.all([racing.startup(), racing.visit("https://mail.google.com/mail/u/1/")]);
  assert.deepEqual(racing.accounts, [0, 1], "Neither writer may drop the other's account");

  /* The worker cannot import the page's helpers, so the two copies of these
     constants are held to each other here. */
  const settings = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync("shared/newtab-settings.js", "utf8"), settings);
  const { mail } = settings.newtabSettings;
  const worker = fs.readFileSync("modules/mail-accounts.js", "utf8");
  assert.ok(worker.includes(`const KEY = "${mail.key}"`), "The worker must write the key the page reads");
  assert.ok(worker.includes(`const ORIGIN = "${mail.origin}"`), "Both sides must mean the same Gmail");
  assert.ok(worker.includes(`const MAX_ACCOUNTS = ${mail.max}`), "A list the page would trim is a list the worker should not write");
  assert.ok(worker.includes(`const CACHE_MAX_AGE = ${mail.cacheMaxAge / (60 * 60 * 1000)} * 60 * 60 * 1000`), "Both sides must agree on when an answer is stale");
  assert.ok(fs.readFileSync("background/service-worker.js", "utf8").includes("initializeMailAccounts()"), "The worker must actually run the discovery");

  console.log("PASS mail accounts: index walk, gaps, signed out, offline, staleness, Gmail visits, module off, write ordering");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
