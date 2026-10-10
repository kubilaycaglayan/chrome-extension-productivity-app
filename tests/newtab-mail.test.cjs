const assert = require("node:assert/strict");
const { setup, queryAll, settle } = require("./newtab-dom.cjs");

// The Gmail corner of the page: one button per account the service worker
// found, read from storage and never probed for here. The discovery itself is
// tests/mail-accounts.test.cjs.
const links = page => queryAll(page.element("mail-links"), "a");
const describe = page => links(page).map(link => [
  link.href,
  link.getAttribute("aria-label"),
  queryAll(link, ".mail-index").map(badge => badge.textContent).join("") || null
]);

(async () => {
  /* Nothing discovered yet: one plain shortcut, which is also what a profile
     signed out of Google is left with. */
  const fresh = setup();
  await settle();
  assert.equal(fresh.element("mail-links").hidden, false, "The shortcut must be on the page from the first paint");
  assert.deepEqual(describe(fresh), [["https://mail.google.com/mail/u/0/", "Gmail", null]]);
  const [icon] = queryAll(fresh.element("mail-links"), ".mail-icon");
  assert.ok(icon.src.startsWith("data:image/svg+xml,"), "The envelope is drawn, not fetched from a favicon cache that may not have it");
  assert.equal(icon.alt, "", "The link is already labelled");
  assert.equal(fresh.fetches.length, 0, "The page must not go looking for accounts itself");
  assert.equal(fresh.store[fresh.settings.mail.key], undefined, "Reading the list must not write one");

  /* Two accounts signed in: a button each, numbered the way Gmail numbers
     them, and the number is in the label rather than only in the badge. */
  const both = setup({ stored: { newtabMailAccounts: { accounts: [0, 1], checkedAt: Date.now() } } });
  await settle();
  assert.deepEqual(describe(both), [
    ["https://mail.google.com/mail/u/0/", "Gmail — account 1", "1"],
    ["https://mail.google.com/mail/u/1/", "Gmail — account 2", "2"]
  ]);
  for (const badge of queryAll(both.element("mail-links"), ".mail-index")) {
    assert.equal(badge.getAttribute("aria-hidden"), "true", "The label already reads the number out");
  }

  /* An account found while this tab sits open shows up without a reload, and
     one that has gone takes its button with it. */
  both.storageChange({ newtabMailAccounts: { newValue: { accounts: [0, 1, 2], checkedAt: Date.now() } } });
  assert.deepEqual(describe(both).map(([url]) => url), [
    "https://mail.google.com/mail/u/0/",
    "https://mail.google.com/mail/u/1/",
    "https://mail.google.com/mail/u/2/"
  ]);
  both.storageChange({ newtabMailAccounts: { newValue: { accounts: [0], checkedAt: Date.now() } } });
  assert.deepEqual(describe(both), [["https://mail.google.com/mail/u/0/", "Gmail", null]], "One account left is one unnumbered button");
  both.storageChange({ newtabMailAccounts: { newValue: { accounts: [], checkedAt: Date.now() } } });
  assert.deepEqual(describe(both), [["https://mail.google.com/mail/u/0/", "Gmail", null]], "Signed out still leaves somewhere to sign in");

  /* Storage is not a trusted source: the list travels through it and a
     hand-edited or half-written value must not reach an href. */
  const hostile = setup({
    stored: {
      newtabMailAccounts: {
        accounts: [1, "2", 1, -1, 99, 1.5, null, "javascript:alert(1)", { index: 3 }],
        checkedAt: Date.now()
      }
    }
  });
  await settle();
  assert.deepEqual(describe(hostile).map(([url]) => url), [
    "https://mail.google.com/mail/u/1/",
    "https://mail.google.com/mail/u/2/"
  ], "Only whole indices in range survive, in order, once each");

  const broken = setup({ stored: { newtabMailAccounts: "nonsense" } });
  await settle();
  assert.deepEqual(describe(broken), [["https://mail.google.com/mail/u/0/", "Gmail", null]]);

  /* Switching the module off clears the corner with the rest of the page. */
  both.toggleModule(false);
  await settle();
  assert.equal(both.element("mail-links").hidden, true, "A disabled page leaves no floating button behind");
  assert.equal(links(both).length, 0);
  both.toggleModule(true);
  await settle();
  assert.equal(both.element("mail-links").hidden, false, "Switching the module back on brings the shortcut back");

  console.log("PASS newtab mail: one Gmail button per discovered account, numbered, live, and only ever read from storage");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
