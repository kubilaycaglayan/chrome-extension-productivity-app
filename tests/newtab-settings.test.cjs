const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = vm.createContext({ URL });

// Values come from another realm, so compare their shape rather than identity.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
vm.runInContext(fs.readFileSync("shared/newtab-settings.js", "utf8"), context);
const settings = context.newtabSettings;

// Addresses: bare hosts are completed, dangerous schemes never survive.
assert.equal(settings.cleanUrl("github.com"), "https://github.com/");
assert.equal(settings.cleanUrl("  http://example.com/path?q=1 "), "http://example.com/path?q=1");
for (const hostile of ["javascript:alert(1)", "data:text/html,<script>", "chrome://settings", "file:///etc/passwd", "", "   ", 42, null]) {
  assert.equal(settings.cleanUrl(hostile), "", `${String(hostile)} must be rejected`);
}

// Search: typed hosts navigate, everything else is a Google query.
assert.equal(settings.searchUrl("hello world"), "https://www.google.com/search?q=hello%20world");
assert.equal(settings.searchUrl("news.ycombinator.com/newest"), "https://news.ycombinator.com/newest");
assert.equal(settings.searchUrl("https://example.com"), "https://example.com/");
assert.equal(settings.searchUrl("mackolik canlı sonuçlar"), `https://www.google.com/search?q=${encodeURIComponent("mackolik canlı sonuçlar")}`);
assert.equal(settings.searchUrl("node.js vs deno"), "https://www.google.com/search?q=node.js%20vs%20deno");
assert.equal(settings.searchUrl("   "), "", "An empty query must not navigate");
assert.equal(settings.searchUrl("javascript:alert(1)"), "https://www.google.com/search?q=javascript%3Aalert(1)");

// Groups: labels default to the host, bad entries are dropped, limits hold.
const cleaned = settings.cleanGroups([
  { name: "  Work  ", bookmarks: [{ url: "github.com" }, { label: "Bad", url: "javascript:void 0" }, { label: "  Mail  ", url: "https://mail.google.com" }] },
  { name: "", bookmarks: [] },
  "nonsense",
  null,
  { name: "Empty but named", bookmarks: "nope" }
]);
assert.equal(cleaned.length, 2);
assert.equal(cleaned[0].name, "Work");
same(cleaned[0].bookmarks.map(b => [b.label, b.url]), [["github.com", "https://github.com/"], ["Mail", "https://mail.google.com/"]]);
assert.equal(cleaned[1].name, "Empty but named");
same(cleaned[1].bookmarks, []);
assert.ok(cleaned.every(group => group.id && group.bookmarks.every(bookmark => bookmark.id)), "Every group and bookmark needs an id");
assert.equal(settings.cleanGroups("nope").length, 0);

const overflowing = settings.cleanGroups(Array.from({ length: 40 }, (_, index) => ({
  name: `G${index}`,
  bookmarks: Array.from({ length: 90 }, (_, n) => ({ url: `https://example.com/${n}` }))
})));
assert.equal(overflowing.length, settings.limits.groups);
assert.equal(overflowing[0].bookmarks.length, settings.limits.bookmarks);
const trimmed = settings.cleanGroups([{ name: "x".repeat(200), bookmarks: [{ label: "y".repeat(200), url: "https://example.com" }] }]);
assert.equal(trimmed[0].name.length, settings.limits.name);
assert.equal(trimmed[0].bookmarks[0].label.length, settings.limits.label);

// Ids survive a round trip so renaming a group does not re-key its bookmarks.
const stable = settings.cleanGroups([{ id: "g1", name: "Keep", bookmarks: [{ id: "b1", label: "Keep", url: "https://example.com" }] }]);
assert.equal(stable[0].id, "g1");
assert.equal(stable[0].bookmarks[0].id, "b1");

// Backgrounds: only vetted shapes are stored, so nothing can inject CSS.
same(settings.cleanBackground({ type: "color", value: "#1b2026" }), { type: "color", value: "#1b2026" });
same(settings.cleanBackground({ type: "gradient", value: settings.gradients[1][1] }), { type: "gradient", value: settings.gradients[1][1] });
const image = { type: "image", value: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" };
same(settings.cleanBackground(image), image);
for (const hostile of [
  undefined,
  { type: "color", value: "red; position: fixed" },
  { type: "color", value: "#fff" },
  { type: "gradient", value: "linear-gradient(#000, #111); background-image: url(http://evil.test/x)" },
  { type: "gradient", value: "url(http://evil.test/x)" },
  { type: "image", value: "https://evil.test/x.png" },
  { type: "image", value: "data:text/html;base64,PHNjcmlwdD4=" },
  { type: "elsewhere", value: "#1b2026" }
]) {
  same(settings.cleanBackground(hostile), settings.defaultBackground, `${JSON.stringify(hostile)} must fall back to the default`);
}

// Google wallpapers: only Backdrop's own host, and credits are kept for display.
const wallpaper = { type: "google", value: "https://lh3.googleusercontent.com/proxy/Token-1_2-3", label: "Coral Reefs", credit: "The Ocean Agency", link: "50reefs.org" };
same(settings.cleanBackground(wallpaper), { ...wallpaper, link: "https://50reefs.org/" });
same(settings.cleanBackground({ type: "google", value: wallpaper.value }), { type: "google", value: wallpaper.value });
for (const hostile of [
  { type: "google", value: "https://evil.test/x.jpg" },
  { type: "google", value: "http://lh3.googleusercontent.com/proxy/x" },
  { type: "google", value: "https://lh3.googleusercontent.com.evil.test/proxy/x" },
  { type: "google", value: "https://lh3.googleusercontent.com/proxy/x?onerror=1" }
]) {
  same(settings.cleanBackground(hostile), settings.defaultBackground, `${hostile.value} must be refused`);
}
const credited = settings.cleanBackground({ type: "google", value: wallpaper.value, label: "x".repeat(400), credit: 7, link: "javascript:alert(1)" });
assert.equal(credited.label.length, settings.limits.credit);
assert.equal(credited.credit, undefined);
assert.equal(credited.link, undefined, "A credit link must still be a web address");

// Wallpapers are requested at the size the screen needs.
const sizedCss = settings.backgroundCss(wallpaper, 2560, 1440);
assert.equal(sizedCss.image, `url("${wallpaper.value}=w2560-h1440-p-k-no-nd-mv")`);
assert.ok(sizedCss.scrim);
assert.equal(settings.backgroundCss(wallpaper).image, `url("${wallpaper.value}=w1920-h1080-p-k-no-nd-mv")`);
assert.equal(settings.backgroundCss({ type: "color", value: "#16211c" }, 800, 600).image, "none", "Sizing never touches a colour");

// Suggest requests, and the replies Google sends back.
assert.equal(settings.suggestUrl("chrome ext", "en-GB"), "https://suggestqueries.google.com/complete/search?client=firefox&hl=en-GB&q=chrome%20ext");
assert.equal(settings.suggestUrl("  "), "", "A blank query asks for nothing");
assert.equal(settings.suggestUrl("a&b=c"), "https://suggestqueries.google.com/complete/search?client=firefox&hl=en-US&q=a%26b%3Dc");
same(settings.parseSuggestions('["c",["cat","cats","cat","","dog"],[],{}]'), ["cat", "cats", "dog"], "Blanks and repeats are dropped");
same(settings.parseSuggestions([["x"], ["one", 2, null, "two"]]), ["one", "two"]);
for (const junk of ["not json", "{}", "[]", '["q"]', '["q",null]', "", undefined]) {
  assert.equal(settings.parseSuggestions(junk).length, 0, `${String(junk)} must yield no suggestions`);
}
assert.equal(settings.parseSuggestions(JSON.stringify(["q", Array.from({ length: 30 }, (_, n) => `s${n}`)])).length, settings.limits.suggestions);

// Reordering: insertAt means "before this index as the list stands now".
const letters = ["a", "b", "c", "d"];
assert.equal(settings.reorder(letters, 0, 2).join(""), "bacd", "Moving right by one");
assert.equal(settings.reorder(letters, 2, 1).join(""), "acbd", "Moving left by one");
assert.equal(settings.reorder(letters, 0, 4).join(""), "bcda", "Moving to the end");
assert.equal(settings.reorder(letters, 3, 0).join(""), "dabc", "Moving to the start");
assert.equal(settings.reorder(letters, 1, 9).join(""), "acdb", "An overshooting drop lands last");
assert.equal(settings.reorder(letters, 1, -3).join(""), "bacd", "An undershooting drop lands first");
assert.equal(settings.reorder(letters, 1, 1), letters, "Dropping an item on itself changes nothing");
assert.equal(settings.reorder(letters, 1, 2), letters, "Dropping just after itself changes nothing");
assert.equal(settings.reorder(letters, 9, 0), letters, "An unknown item is left alone");
assert.equal(letters.join(""), "abcd", "The original list is never mutated");

const [source, target] = settings.transfer(["a", "b", "c"], 1, ["x", "y"], 1);
assert.equal(source.join(""), "ac");
assert.equal(target.join(""), "xby");
assert.equal(settings.transfer(["a"], 0, [], 5)[1].join(""), "a", "An empty group accepts a drop");
same(settings.transfer(["a"], 3, ["x"], 0), [["a"], ["x"]], "An unknown item is left alone");

// Every preset is itself valid, and image backgrounds ask for the scrim.
for (const [, value] of settings.colors) same(settings.cleanBackground({ type: "color", value }), { type: "color", value });
for (const [, value] of settings.gradients) same(settings.cleanBackground({ type: "gradient", value }), { type: "gradient", value });
same(settings.backgroundCss({ type: "color", value: "#16211c" }), { color: "#16211c", image: "none", scrim: false });
assert.equal(settings.backgroundCss({ type: "gradient", value: settings.gradients[0][1] }).image, settings.gradients[0][1]);
const imageCss = settings.backgroundCss(image);
assert.equal(imageCss.image, `url("${image.value}")`);
assert.ok(imageCss.scrim, "Image backgrounds must dim behind the text");
assert.equal(settings.backgroundCss("garbage").scrim, false);

// Importing a bookmark tree.
const tree = [{
  id: "0",
  children: [
    { id: "1", title: "Bookmarks bar", children: [
      { id: "10", title: "GitHub", url: "https://github.com" },
      { id: "11", title: "Work", children: [
        { id: "12", title: "Jira", url: "https://jira.example.com" },
        { id: "13", title: "Deeper", children: [{ id: "14", title: "Wiki", url: "https://wiki.example.com" }] }
      ] },
      { id: "15", title: "Empty folder", children: [] },
      { id: "16", title: "", url: "https://mail.google.com" },
      { id: "17", title: "Script", url: "javascript:alert(1)" },
      { id: "18", title: "Repeat", url: "https://github.com" }
    ] },
    { id: "2", title: "Other bookmarks", children: [{ id: "20", title: "HN", url: "https://news.ycombinator.com" }] },
    { id: "3", title: "Mobile bookmarks", children: [] }
  ]
}];
const imported = settings.bookmarkGroups(tree);
same(imported.map(group => [group.name, group.bookmarks.map(bookmark => bookmark.label)]), [
  ["Bookmarks bar", ["GitHub", "mail.google.com", "Repeat"]],
  ["Work", ["Jira", "Wiki"]],
  ["Other bookmarks", ["HN"]]
], "Loose bar items lead, folders follow, empties and bad schemes are dropped");
assert.ok(imported.every(group => group.id && group.bookmarks.every(bookmark => bookmark.id)));
for (const junk of [undefined, null, "tree", [], [null], [{ id: "0", children: null }], [{ id: "0", children: [{ title: "Bar", children: [] }] }]]) {
  assert.equal(settings.bookmarkGroups(junk).length, 0, `${JSON.stringify(junk)} must import nothing`);
}

// A folder deeper than the flattening limit, and one past the bookmark cap.
const deep = { title: "Deep", children: [] };
let cursor = deep;
for (let level = 0; level < 8; level++) {
  const next = { title: `L${level}`, children: [{ title: `Leaf ${level}`, url: `https://example.com/${level}` }] };
  cursor.children.push(next);
  cursor = next;
}
assert.ok(settings.flattenBookmarks(deep).length < 8, "Flattening stops before it walks the whole tree");
const wide = { title: "Wide", children: Array.from({ length: 90 }, (_, n) => ({ title: `B${n}`, url: `https://example.com/${n}` })) };
assert.equal(settings.flattenBookmarks(wide).length, settings.limits.bookmarks);
const repeated = { title: "Repeats", children: [
  { title: "One", url: "https://example.com" },
  { title: "Again", url: "https://example.com/" },
  { title: "Folder", children: [{ title: "Third", url: "https://example.com" }] }
] };
assert.equal(settings.flattenBookmarks(repeated).length, 1, "The same address is imported once");

// Chrome's New Tab tiles, used when there are no bookmarks to borrow.
const tiles = settings.topSitesGroup([
  { title: "Hugging Face", url: "https://huggingface.co" },
  { title: "", url: "https://news.ycombinator.com" },
  { title: "Internal", url: "chrome://history" },
  { url: "" }
]);
assert.equal(tiles.name, "Most visited");
same(tiles.bookmarks.map(bookmark => bookmark.label), ["Hugging Face", "news.ycombinator.com"]);
for (const empty of [[], undefined, "nope", [{ url: "chrome://history" }]]) {
  assert.equal(settings.topSitesGroup(empty), null, "No usable tiles means no group");
}

// First run ships usable groups rather than an empty page.
assert.ok(settings.defaultGroups.length >= 2);
assert.ok(settings.defaultGroups.every(group => group.bookmarks.length > 0));
assert.notEqual(settings.randomId(), settings.randomId());

// Gmail accounts, known by email: the worker reads them from the list Chrome's
// own avatar menu uses, and the page links each by that email.
const { mail } = settings;
assert.equal(mail.url("me@gmail.com"), "https://mail.google.com/mail/?authuser=me%40gmail.com");
assert.equal(mail.url("a+b&c=d@x.co"), "https://mail.google.com/mail/?authuser=a%2Bb%26c%3Dd%40x.co", "An email is a query value, encoded");
for (const nonsense of [undefined, null, 3, "", "two", "javascript:alert(1)", "a b@c.d", "<x>@y.z"]) {
  assert.equal(mail.url(nonsense), "https://mail.google.com/mail/u/0/", `${String(nonsense)} must fall back to the first account`);
}

same(mail.clean([
  { email: " Work@Example.com ", name: " Work " },
  { email: "work@example.com" },
  { email: "me@gmail.com", name: 7 },
  0, "me@gmail.com", null, { email: "nope" }
]), [{ email: "Work@Example.com", name: "Work" }, { email: "me@gmail.com" }], "Well-formed emails, once each regardless of case, in Google's order");
same(mail.clean("nonsense"), []);
assert.equal(mail.clean(Array.from({ length: 50 }, (_, n) => ({ email: `u${n}@x.co` }))).length, mail.max);

// Hidden accounts are a list of emails, kept in lower case.
same(mail.cleanHidden(["Me@Gmail.com", "me@gmail.com", 3, "bad", null]), ["me@gmail.com"]);
same(mail.cleanHidden("nonsense"), []);
assert.equal(mail.isHidden(["me@gmail.com"], "ME@gmail.com"), true);
assert.equal(mail.isHidden(["me@gmail.com"], "work@example.com"), false);
same(mail.toggleHidden([], "Me@gmail.com"), ["me@gmail.com"]);
same(mail.toggleHidden(["me@gmail.com", "w@x.co"], "ME@gmail.com"), ["w@x.co"], "Showing one leaves the others hidden");
same(mail.toggleHidden(["w@x.co"], "not an email"), ["w@x.co"]);

assert.equal(mail.label(null), "Gmail");
assert.equal(mail.label({ email: "me@gmail.com" }), "Gmail \u2014 me@gmail.com");

console.log("PASS newtab settings: address sanitising, search routing, group limits, background validation, Gmail accounts and hiding");
