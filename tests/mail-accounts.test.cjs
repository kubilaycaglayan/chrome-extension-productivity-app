const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Finding which Google accounts a profile is signed into. There is no API for
// it, so the worker reads the list Chrome's own avatar menu is painted from,
// accounts.google.com/ListAccounts, and keeps only the accounts whose session
// is live. The page side of this is tests/newtab-mail.test.cjs.
const LIST_URL = "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard";

// One ListAccounts entry, in the positional shape Google sends and Chromium
// reads: [2] name, [3] email, [9] session valid, [10] id, [14] signed out.
function entry(email, { name = "", valid = 1, signedOut = 0 } = {}) {
  return ["gaia.l.a", 1, name, email, "https://lh3.googleusercontent.com/a/photo", 1, 1, 0, null, valid, "1234567890", null, null, null, signedOut, 1];
}
const answer = entries => JSON.stringify(["gaia.l.a.r", entries]);

function setup({ stored = {}, reply = answer([]), offline = false, status = 200 } = {}) {
  const store = structuredClone(stored);
  const listeners = {};
  const fetches = [];
  const sessionRules = [];

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
      id: "productivity",
      onStartup: { addListener(listener) { listeners.startup = listener; } },
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } }
    },
    tabs: { onUpdated: { addListener(listener) { listeners.updated = listener; } } },
    declarativeNetRequest: {
      async updateSessionRules(update) { sessionRules.push(structuredClone(update)); }
    }
  };

  const context = vm.createContext({
    chrome,
    URL,
    JSON,
    Date,
    Number,
    String,
    Array,
    async fetch(url, options) {
      fetches.push({ url, options });
      if (offline) throw new Error("offline");
      return { ok: status === 200, status, text: async () => (typeof reply === "function" ? reply() : reply) };
    }
  });
  context.globalThis = context;

  const source = fs.readFileSync("modules/mail-accounts.js", "utf8")
    // The same lines modules/settings.js exports, inlined.
    .replace('import { isModuleEnabled } from "./settings.js";',
      'const isModuleEnabled = async id => (await chrome.storage.local.get(`moduleEnabled:${id}`))[`moduleEnabled:${id}`] !== false;')
    .replace(/export function /g, "function ");
  vm.runInContext(`${source}\ninitializeMailAccounts();\nglobalThis.parseListAccounts = parseListAccounts;`, context);

  return {
    store,
    fetches,
    sessionRules,
    parse: context.parseListAccounts,
    get accounts() { return store.newtabMailAccounts?.accounts; },
    get checkedAt() { return store.newtabMailAccounts?.checkedAt; },
    startup: () => listeners.startup(),
    installed: () => listeners.installed({ reason: "update" }),
    visit: url => listeners.updated(7, { url }, { id: 7, url }),
    // The listener answers nothing, so the work is waited on through storage.
    async nudge(message = { type: "mail-accounts:refresh" }) {
      listeners.message(message, {}, () => {});
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    }
  };
}

const day = 24 * 60 * 60 * 1000;
const json = value => JSON.parse(JSON.stringify(value));

(async () => {
  /* The bug this replaced: an account Chrome only remembers for "continue as"
     is in the list, flagged signed out, and must not get a button. Nor must
     one whose session has expired. Order is Google's. */
  const mixed = setup({
    reply: answer([
      entry("work@example.com", { name: "Work" }),
      entry("remembered@gmail.com", { signedOut: 1 }),
      entry("expired@gmail.com", { valid: 0 }),
      entry("me@gmail.com")
    ])
  });
  await mixed.startup();
  assert.deepEqual(json(mixed.accounts), [{ email: "work@example.com", name: "Work" }, { email: "me@gmail.com" }]);
  assert.ok(Date.now() - mixed.checkedAt < 5000, "The answer is stamped so it can go stale");

  const [{ url, options }] = mixed.fetches;
  assert.equal(url, LIST_URL);
  assert.equal(options.method, "POST", "ListAccounts refuses a GET");
  assert.equal(options.credentials, "include", "The cookies are the question being asked");
  assert.equal(options.cache, "no-store", "A cached answer would speak for a session that has changed");

  /* Google refuses the extension's Origin, so a session rule strips it -- from
     this request, from this extension, and nothing else. */
  const [rule] = mixed.sessionRules[0].addRules;
  assert.deepEqual(mixed.sessionRules[0].removeRuleIds, [rule.id], "Re-adding the rule must replace it, not collide with it");
  assert.deepEqual(json(rule.action), { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] });
  assert.equal(rule.condition.urlFilter, "|https://accounts.google.com/ListAccounts");
  assert.deepEqual(json(rule.condition.initiatorDomains), ["productivity"]);
  assert.deepEqual(json(rule.condition.resourceTypes), ["xmlhttprequest"]);
  const adBlocker = fs.readFileSync("modules/ad-blocker.js", "utf8");
  const csvViewer = fs.readFileSync("modules/csv-viewer.js", "utf8");
  assert.ok(rule.id >= 1000400 && rule.id !== Number(csvViewer.match(/RULE_ID = (\d+)/)[1]), "The rule id must not land in another module's range");
  assert.ok(adBlocker.includes("RULE_ID_START + 400"), "The ad blocker's range is the one checked above");

  /* The parser is strict about the shape, and lenient about the flags an
     older answer leaves off. */
  const { parse } = mixed;
  assert.equal(parse("<html>Error 403</html>"), null);
  assert.equal(parse(JSON.stringify(["something.else", []])), null);
  assert.deepEqual(json(parse(`)]}'\n${answer([entry("a@b.co")])}`)), [{ email: "a@b.co" }], "An XSSI guard is stripped");
  assert.deepEqual(json(parse(JSON.stringify(["gaia.l.a.r", [["gaia.l.a", 1, "Old", "old@gmail.com"]]]))), [{ email: "old@gmail.com", name: "Old" }],
    "No flags at all is the old, signed-in shape");
  assert.deepEqual(json(parse(answer([entry("A@b.co"), entry("a@b.co"), entry("not an email"), entry(""), "junk", null]))), [{ email: "A@b.co" }]);
  assert.equal(parse(answer(Array.from({ length: 20 }, (_, n) => entry(`u${n}@b.co`)))).length, 6);

  /* Signed out of Google altogether is a real answer, and an empty list is
     what the page turns back into its single plain shortcut. */
  const out = setup({ stored: { newtabMailAccounts: { accounts: [{ email: "me@gmail.com" }], checkedAt: Date.now() - 2 * day } } });
  await out.startup();
  assert.deepEqual(json(out.accounts), [], "The list is authoritative: a signed-out account loses its button");

  /* Unreachable, refused or garbled says nothing rather than reporting an
     empty list. */
  for (const failing of [{ offline: true }, { status: 403 }, { reply: "<html>Bad Request</html>" }]) {
    const kept = setup({ stored: { newtabMailAccounts: { accounts: [{ email: "me@gmail.com" }], checkedAt: 0 } }, ...failing });
    await kept.startup();
    assert.deepEqual(json(kept.accounts), [{ email: "me@gmail.com" }], `${JSON.stringify(failing)} must not throw away yesterday's list`);
    assert.equal(kept.checkedAt, 0, "...nor stamp it as checked");
  }

  /* Startup keeps to the twice-a-day budget; an update re-asks regardless. */
  const fresh = setup({ stored: { newtabMailAccounts: { accounts: [], checkedAt: Date.now() - 60 * 60 * 1000 } }, reply: answer([entry("me@gmail.com")]) });
  await fresh.startup();
  assert.equal(fresh.fetches.length, 0, "Twice a day is the startup budget");
  await fresh.installed();
  assert.deepEqual(json(fresh.accounts), [{ email: "me@gmail.com" }]);

  /* A new tab opening, or a visit to where accounts are signed into and out
     of, re-asks once the list is more than a minute old -- which is what
     makes a sign-out show up within a tab or two. */
  const nudged = setup({ stored: { newtabMailAccounts: { accounts: [], checkedAt: Date.now() - 2 * 60 * 1000 } }, reply: answer([entry("me@gmail.com")]) });
  await nudged.nudge();
  assert.equal(nudged.fetches.length, 1);
  assert.deepEqual(json(nudged.accounts), [{ email: "me@gmail.com" }]);
  await nudged.nudge();
  await nudged.visit("https://mail.google.com/mail/u/0/#inbox");
  assert.equal(nudged.fetches.length, 1, "A list a few seconds old is left alone");
  await nudged.nudge({ type: "ad-blocker:get" });
  assert.equal(nudged.fetches.length, 1, "Other modules' messages are not this one's business");

  for (const page of ["https://mail.google.com/mail/u/1/", "https://accounts.google.com/Logout", "https://accounts.google.com/AccountChooser"]) {
    const visited = setup({ stored: { newtabMailAccounts: { accounts: [], checkedAt: Date.now() - 2 * 60 * 1000 } } });
    await visited.visit(page);
    assert.equal(visited.fetches.length, 1, `${page} is where accounts change`);
  }
  const ignored = setup({ stored: { newtabMailAccounts: { accounts: [], checkedAt: 0 } } });
  for (const elsewhere of ["https://mail.google.com.evil.example/mail/u/1/", "https://example.com/", "not a url", undefined]) {
    await ignored.visit(elsewhere);
  }
  assert.equal(ignored.fetches.length, 0, "Unrelated tab updates cost nothing");

  /* Nothing happens at all for a profile that has the page switched off. */
  const off = setup({ stored: { "moduleEnabled:newtab": false }, reply: answer([entry("me@gmail.com")]) });
  await off.startup();
  await off.installed();
  await off.visit("https://mail.google.com/mail/u/1/");
  await off.nudge();
  assert.equal(off.fetches.length, 0, "A page nobody uses must not call Google");
  assert.equal(off.accounts, undefined, "...and must not write a list either");

  /* Overlapping triggers queue, so the second sees the first one's stamp
     instead of asking again. */
  const racing = setup({ stored: { newtabMailAccounts: { accounts: [], checkedAt: 0 } }, reply: answer([entry("me@gmail.com")]) });
  await Promise.all([racing.installed(), racing.visit("https://mail.google.com/mail/u/0/")]);
  assert.equal(racing.fetches.length, 1);

  /* The worker cannot import the page's helpers, so the two copies of these
     constants are held to each other here. */
  const settings = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync("shared/newtab-settings.js", "utf8"), settings);
  const { mail } = settings.newtabSettings;
  const worker = fs.readFileSync("modules/mail-accounts.js", "utf8");
  assert.ok(worker.includes(`const KEY = "${mail.key}"`), "The worker must write the key the page reads");
  assert.ok(worker.includes(`const REFRESH_MESSAGE = "${mail.refreshMessage}"`), "The page's nudge must be the message the worker listens for");
  assert.ok(worker.includes(`const MAX_ACCOUNTS = ${mail.max}`), "A list the page would trim is a list the worker should not write");
  assert.ok(worker.includes(`const CACHE_MAX_AGE = ${mail.cacheMaxAge / (60 * 60 * 1000)} * 60 * 60 * 1000`), "Both sides must agree on when an answer is stale");
  assert.ok(fs.readFileSync("background/service-worker.js", "utf8").includes("initializeMailAccounts()"), "The worker must actually run the discovery");

  console.log("PASS mail accounts: ListAccounts, signed-out and expired accounts dropped, Origin rule, offline, staleness, nudges, module off, queueing");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
