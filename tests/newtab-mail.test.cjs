const assert = require("node:assert/strict");
const { setup, queryAll, settle } = require("./newtab-dom.cjs");

// The Gmail corner of the page: a column of buttons, one per account the
// service worker found signed in, each showing the email it opens. The list
// is read from storage and never
// fetched here; the discovery itself is tests/mail-accounts.test.cjs.
const rows = page => page.element("mail-links").children;
const links = page => queryAll(page.element("mail-links"), "a");
const describe = page => links(page).map(link => [
  link.href,
  link.getAttribute("aria-label"),
  queryAll(link, ".mail-email").map(node => node.textContent).join("") || null
]);
const accounts = list => ({ newtabMailAccounts: { accounts: list, checkedAt: Date.now() } });
const ME = "https://mail.google.com/mail/?authuser=me%40gmail.com";
const WORK = "https://mail.google.com/mail/?authuser=work%40example.com";

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
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.messages)), [{ type: "mail-accounts:refresh" }], "...but it does tell the worker the list is about to be looked at");
  assert.equal(fresh.store[fresh.settings.mail.key], undefined, "Reading the list must not write one");

  /* Two accounts signed in: a row each, top to bottom in Google's order, the
     email written on the button and opened by it. */
  const both = setup({ stored: accounts([{ email: "work@example.com", name: "Work" }, { email: "me@gmail.com" }]) });
  await settle();
  assert.deepEqual(describe(both), [
    [WORK, "Gmail — work@example.com", "work@example.com"],
    [ME, "Gmail — me@gmail.com", "me@gmail.com"]
  ]);
  assert.equal(links(both)[0].title, "Work — work@example.com", "A name, when Google has one, is in the tooltip");
  assert.equal(both.body.style["--mail-room"], "232px", "The chips are told how much room the column takes");
  assert.equal(both.body.style["--mail-bottom"], "40px", "...and the chooser where it ends");

  /* Accounts signed in or out show up without a reload. */
  both.storageChange({ newtabMailAccounts: { newValue: { accounts: [{ email: "me@gmail.com" }], checkedAt: Date.now() } } });
  assert.deepEqual(describe(both), [[ME, "Gmail — me@gmail.com", "me@gmail.com"]]);
  both.storageChange({ newtabMailAccounts: { newValue: { accounts: [], checkedAt: Date.now() } } });
  assert.deepEqual(describe(both), [["https://mail.google.com/mail/u/0/", "Gmail", null]], "Signed out still leaves somewhere to sign in");

  /* Storage is not a trusted source: the list travels through it and a
     hand-edited, half-written or older-format value must not reach an href. */
  const hostile = setup({
    stored: accounts([
      { email: "me@gmail.com" }, { email: "ME@gmail.com" }, 1, "2", null,
      { email: "javascript:alert(1)" }, { email: "<b>@x.y" }, { email: "a b@c.d" }, { name: "no email" }
    ])
  });
  await settle();
  assert.deepEqual(describe(hostile).map(([url]) => url), [ME], "Only well-formed emails survive, once each");

  const old = setup({ stored: accounts([0, 1]) });
  await settle();
  assert.deepEqual(describe(old), [["https://mail.google.com/mail/u/0/", "Gmail", null]], "The old index-only list is waited out, not misread");

  const broken = setup({ stored: { newtabMailAccounts: "nonsense" } });
  await settle();
  assert.deepEqual(describe(broken), [["https://mail.google.com/mail/u/0/", "Gmail", null]]);

  /* Switching the module off clears the corner with the rest of the page. */
  both.storageChange({ newtabMailAccounts: { newValue: { accounts: [{ email: "me@gmail.com" }], checkedAt: Date.now() } } });
  both.toggleModule(false);
  await settle();
  assert.equal(both.element("mail-links").hidden, true, "A disabled page leaves no floating button behind");
  assert.equal(links(both).length, 0);
  assert.equal(both.body.style["--mail-room"], undefined);
  assert.equal(both.body.style["--mail-bottom"], undefined);
  both.toggleModule(true);
  await settle();
  assert.equal(both.element("mail-links").hidden, false, "Switching the module back on brings the shortcut back");

  console.log("PASS newtab mail: a labelled column of signed-in accounts, live, and only ever read from storage");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
