const assert = require("node:assert/strict");
const { setup, fire, queryAll, settle } = require("./newtab-dom.cjs");

// The Gmail corner of the page: a column of buttons, one per account the
// service worker found signed in, each showing the email it opens. Accounts
// can be hidden from edit mode. The list is read from storage and never
// fetched here; the discovery itself is tests/mail-accounts.test.cjs.
const rows = page => page.element("mail-links").children;
const links = page => queryAll(page.element("mail-links"), "a");
const toggles = page => queryAll(page.element("mail-links"), ".mail-toggle");
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
    [WORK, "Gmail — work@example.com", "work"],
    [ME, "Gmail — me@gmail.com", "me"]
  ], "A button reads the username; the label and link carry the whole email");
  assert.equal(links(both)[0].title, "Work — work@example.com", "A name, when Google has one, is in the tooltip");
  assert.equal(toggles(both).length, 0, "Hiding is an edit, so the switches wait for edit mode");
  assert.equal(both.body.style["--mail-room"], "232px", "The chips are told how much room the column takes");
  assert.equal(both.body.style["--mail-bottom"], "40px", "...and the chooser where it ends");

  /* Hiding: edit mode lays a switch beside every account, and a hidden one
     stays listed there, dimmed, so it can be shown again. */
  fire(both.element("edit-toggle"), "click");
  assert.deepEqual(toggles(both).map(toggle => toggle.textContent), ["Hide", "Hide"]);
  assert.equal(toggles(both)[1].getAttribute("aria-label"), "Hide me@gmail.com on the new tab");
  fire(toggles(both)[1], "click");
  await settle();
  assert.deepEqual(both.store.newtabMailHidden, ["me@gmail.com"], "The choice is saved");
  assert.equal(links(both).length, 2, "While editing, a hidden account is still there to be shown again");
  assert.ok(rows(both)[1].classList.contains("is-hidden"));
  assert.ok(!rows(both)[0].classList.contains("is-hidden"));
  assert.equal(toggles(both)[1].textContent, "Show");
  assert.equal(toggles(both)[1].getAttribute("aria-pressed"), "true");
  assert.ok(toggles(both)[1].focused, "The keyboard stays on the switch it pressed");
  assert.match(both.status(), /me@gmail\.com hidden/);

  fire(both.element("edit-toggle"), "click");
  assert.deepEqual(describe(both), [[WORK, "Gmail — work@example.com", "work"]], "Done editing, a hidden account is gone");
  assert.equal(toggles(both).length, 0);

  /* ...and it comes back when shown again. */
  fire(both.element("edit-toggle"), "click");
  fire(toggles(both)[1], "click");
  await settle();
  assert.deepEqual(both.store.newtabMailHidden, []);
  fire(both.element("edit-toggle"), "click");
  assert.equal(links(both).length, 2);

  /* Hiding every account leaves the corner empty, not a plain fallback the
     user did not ask for. */
  const allHidden = setup({ stored: { ...accounts([{ email: "me@gmail.com" }]), newtabMailHidden: ["ME@gmail.com"] } });
  await settle();
  assert.equal(allHidden.element("mail-links").hidden, true);
  assert.equal(allHidden.body.style["--mail-room"], undefined, "An empty corner needs no room");
  fire(allHidden.element("edit-toggle"), "click");
  assert.equal(allHidden.element("mail-links").hidden, false, "Edit mode is where it can be brought back");
  assert.equal(toggles(allHidden)[0].textContent, "Show", "Hidden is matched without regard to case");

  /* Accounts signed in or out, or hidden from another tab, show up without
     a reload. */
  both.storageChange({ newtabMailAccounts: { newValue: { accounts: [{ email: "me@gmail.com" }], checkedAt: Date.now() } } });
  assert.deepEqual(describe(both), [[ME, "Gmail — me@gmail.com", "me"]]);
  both.storageChange({ newtabMailHidden: { newValue: ["me@gmail.com"] } });
  assert.equal(links(both).length, 0);
  both.storageChange({ newtabMailHidden: { newValue: [] } });
  both.storageChange({ newtabMailAccounts: { newValue: { accounts: [], checkedAt: Date.now() } } });
  assert.deepEqual(describe(both), [["https://mail.google.com/mail/u/0/", "Gmail", null]], "Signed out still leaves somewhere to sign in");

  /* Two accounts sharing a username would read the same, so those two keep
     their whole email; the rest stay short. */
  const twins = setup({ stored: accounts([{ email: "me@gmail.com" }, { email: "Me@example.com" }, { email: "work@example.com" }]) });
  await settle();
  assert.deepEqual(describe(twins).map(([, , text]) => text), ["me@gmail.com", "Me@example.com", "work"]);

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

  const broken = setup({ stored: { newtabMailAccounts: "nonsense", newtabMailHidden: "nonsense" } });
  await settle();
  assert.deepEqual(describe(broken), [["https://mail.google.com/mail/u/0/", "Gmail", null]]);

  /* Custom inboxes: edit mode ends the column with an Add button, whose dialog
     takes a label and an address, and the new inbox is listed under the
     Google accounts with the site's own icon. */
  const save = (page, label, url) => {
    page.element("inbox-label").value = label;
    page.element("inbox-url").value = url;
    page.element("inbox-dialog").returnValue = "save";
    page.element("inbox-dialog").close();
  };
  const addButton = page => queryAll(page.element("mail-links"), ".mail-add")[0];
  const custom = setup({ stored: accounts([{ email: "me@gmail.com" }]) });
  await settle();
  assert.equal(addButton(custom), undefined, "Adding is an edit, so the button waits for edit mode");
  fire(custom.element("edit-toggle"), "click");
  fire(addButton(custom), "click");
  assert.equal(custom.element("inbox-dialog").open, true);
  assert.equal(custom.element("inbox-dialog-title").textContent, "Add inbox");
  save(custom, "", "outlook.live.com/mail/");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(custom.store.newtabMailCustom)).map(({ label, url }) => [label, url]),
    [["outlook.live.com", "https://outlook.live.com/mail/"]], "A bare address is completed, and the site names it when no label is given");
  fire(addButton(custom), "click");
  save(custom, "Work", "https://webmail.example.com/");
  await settle();
  assert.deepEqual(describe(custom).map(([url, label, text]) => [url, label, text]), [
    [ME, "Gmail — me@gmail.com", "me"],
    ["https://outlook.live.com/mail/", "outlook.live.com", "outlook.live.com"],
    ["https://webmail.example.com/", "Work", "Work"]
  ], "Custom inboxes come after the Google accounts, in the order they were added");
  const [, outlookIcon] = queryAll(custom.element("mail-links"), ".mail-icon");
  assert.ok(outlookIcon.src.includes("_favicon/?pageUrl=https%3A%2F%2Foutlook.live.com%2Fmail%2F"), "A custom inbox wears its site's icon");
  fire(outlookIcon, "error");
  assert.ok(queryAll(custom.element("mail-links"), ".mail-icon")[1].src.startsWith("data:image/svg+xml,"), "...or the envelope, when Chrome has none");

  /* Edit and Remove sit beside each custom inbox while editing. */
  const workRow = rows(custom)[2];
  assert.deepEqual(queryAll(workRow, ".mail-toggle").map(button => button.textContent), ["Edit", "Remove"]);
  fire(queryAll(workRow, ".mail-toggle")[0], "click");
  assert.equal(custom.element("inbox-dialog-title").textContent, "Edit inbox");
  assert.equal(custom.element("inbox-url").value, "https://webmail.example.com/", "Editing starts from what is there");
  save(custom, "Office", "webmail.example.com/inbox");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(custom.store.newtabMailCustom)).map(({ label }) => label), ["outlook.live.com", "Office"], "An edit stays in place");
  fire(queryAll(rows(custom)[1], ".mail-toggle")[1], "click");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(custom.store.newtabMailCustom)).map(({ label }) => label), ["Office"]);
  assert.match(custom.status(), /outlook\.live\.com removed/);

  /* An address that cannot be a web page is refused, and nothing is saved. */
  fire(addButton(custom), "click");
  save(custom, "Bad", "javascript:alert(1)");
  await settle();
  assert.equal(custom.element("inbox-error").hidden, false, "The dialog says why");
  assert.equal(custom.store.newtabMailCustom.length, 1);

  /* Cancel is a no. */
  fire(addButton(custom), "click");
  custom.element("inbox-url").value = "proton.me/mail";
  fire(custom.element("inbox-cancel"), "click");
  await settle();
  assert.equal(custom.store.newtabMailCustom.length, 1);

  /* Done editing, the switches and the Add button go; the inbox stays. */
  fire(custom.element("edit-toggle"), "click");
  assert.equal(addButton(custom), undefined);
  assert.equal(toggles(custom).length, 0);
  assert.equal(links(custom).length, 2);

  /* With no Google account but inboxes of their own, the corner is the
     user's: no plain Gmail button is pushed in. The list is capped, and the
     Add button says so rather than failing on save. */
  const own = setup({ stored: { newtabMailCustom: [{ id: "a", label: "Proton", url: "https://mail.proton.me/" }, { url: "javascript:alert(1)" }, { url: 7 }] } });
  await settle();
  assert.deepEqual(describe(own), [["https://mail.proton.me/", "Proton", "Proton"]], "Only an http(s) address survives storage");
  const full = setup({ stored: { newtabMailCustom: Array.from({ length: 12 }, (_, n) => ({ label: `Inbox ${n}`, url: `https://mail${n}.example.com/` })) } });
  await settle();
  assert.equal(links(full).length, 8);
  fire(full.element("edit-toggle"), "click");
  assert.equal(addButton(full).disabled, true);

  /* An inbox added in another tab shows up here too. */
  own.storageChange({ newtabMailCustom: { newValue: [] } });
  assert.deepEqual(describe(own), [["https://mail.google.com/mail/u/0/", "Gmail", null]], "Nothing left means the plain Gmail button again");

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

  console.log("PASS newtab mail: a labelled column of signed-in accounts, hidden from edit mode, custom inboxes added, edited and removed, live, and only ever read from storage");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
