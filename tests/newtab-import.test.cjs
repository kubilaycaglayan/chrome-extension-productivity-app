const assert = require("node:assert/strict");
const { setup, fire, settle } = require("./newtab-dom.cjs");

const TREE = [{
  id: "0",
  children: [
    {
      id: "1",
      title: "Bookmarks bar",
      children: [
        { id: "10", title: "GitHub", url: "https://github.com" },
        { id: "11", title: "Work", children: [
          { id: "12", title: "Jira", url: "https://jira.example.com" },
          { id: "13", title: "Nested", children: [{ id: "14", title: "Wiki", url: "https://wiki.example.com" }] }
        ] },
        { id: "15", title: "Empty", children: [] },
        { id: "16", title: "Gmail", url: "https://mail.google.com" },
        { id: "17", title: "Bad", url: "javascript:alert(1)" }
      ]
    },
    { id: "2", title: "Other bookmarks", children: [{ id: "20", title: "Hacker News", url: "https://news.ycombinator.com" }] },
    { id: "3", title: "Mobile bookmarks", children: [] }
  ]
}];

(async () => {
  /* First run takes the bookmarks bar as it stands. */
  const page = setup({ tree: TREE, topSites: [{ title: "Ignored", url: "https://example.com" }] });
  await settle();
  assert.deepEqual(page.groupNames(), ["Bookmarks bar", "Work", "Other bookmarks"],
    "Loose bar bookmarks lead, then each bar folder, then the other roots");
  assert.deepEqual(page.tileLabels(0), ["GitHub", "Gmail"], "Unusable addresses are left out");
  assert.deepEqual(page.tileLabels(1), ["Jira", "Wiki"], "Nested folders are flattened into their group");
  assert.deepEqual(page.tileLabels(2), ["Hacker News"]);
  assert.deepEqual(page.store[page.settings.groupsKey].map(group => group.name), ["Bookmarks bar", "Work", "Other bookmarks"],
    "The imported layout is saved, so later edits stick");
  assert.equal(page.element("import-bookmarks").hidden, false);

  /* With no bookmarks at all, Chrome's own New Tab tiles stand in. */
  const tiles = setup({ topSites: [
    { title: "Hugging Face", url: "https://huggingface.co" },
    { title: "", url: "https://news.ycombinator.com" },
    { title: "Junk", url: "chrome://history" }
  ] });
  await settle();
  assert.deepEqual(tiles.groupNames(), ["Most visited"]);
  assert.deepEqual(tiles.tileLabels(0), ["Hugging Face", "news.ycombinator.com"],
    "A tile with no title falls back to its host, and internal pages are skipped");

  /* With neither, the starter set keeps the page from being empty. */
  const bare = setup();
  await settle();
  assert.deepEqual(bare.groupNames(), ["Daily", "Dev"]);

  /* Stored groups always win: an import never runs twice by itself. */
  const returning = setup({ tree: TREE, stored: { newtabGroups: [{ id: "g1", name: "Mine", bookmarks: [{ id: "b1", label: "Only", url: "https://example.com" }] }] } });
  await settle();
  assert.deepEqual(returning.groupNames(), ["Mine"]);
  assert.equal(returning.writes.length, 0, "A returning visit writes nothing on load");

  /* The button imports into a page that was seeded before this existed. */
  fire(returning.element("import-bookmarks"), "click");
  await settle();
  assert.deepEqual(returning.groupNames(), ["Mine", "Bookmarks bar", "Work", "Other bookmarks"]);
  assert.deepEqual(returning.tileLabels(0), ["Only"], "Existing groups are left as they are");
  assert.ok(returning.status().includes("Imported 5 bookmarks in 3 new groups"), returning.status());

  /* Pressing it again changes nothing. */
  const settled = returning.writes.length;
  fire(returning.element("import-bookmarks"), "click");
  await settle();
  assert.equal(returning.writes.length, settled, "A second import must not write");
  assert.deepEqual(returning.groupNames(), ["Mine", "Bookmarks bar", "Work", "Other bookmarks"]);
  assert.ok(returning.status().includes("already here"));

  /* A same-named group gains only the bookmarks it is missing. */
  const merging = setup({
    tree: TREE,
    stored: { newtabGroups: [{ id: "g1", name: "work", bookmarks: [{ id: "b1", label: "Jira", url: "https://jira.example.com/" }] }] }
  });
  await settle();
  fire(merging.element("import-bookmarks"), "click");
  await settle();
  assert.deepEqual(merging.groupNames(), ["work", "Bookmarks bar", "Other bookmarks"],
    "The matching folder merges instead of arriving twice");
  assert.deepEqual(merging.tileLabels(0), ["Jira", "Wiki"]);
  assert.ok(merging.status().includes("Imported 4 bookmarks in 2 new groups"), merging.status());

  /* Without the bookmarks API the button stays hidden and the page still loads. */
  const plain = setup({ tree: null, topSites: null });
  await settle();
  assert.equal(plain.element("import-bookmarks").hidden, true);
  assert.deepEqual(plain.groupNames(), ["Daily", "Dev"]);

  /* A bookmarks API that throws is no worse than one that is missing. */
  const broken = setup({ topSites: [{ title: "Hugging Face", url: "https://huggingface.co" }] });
  broken.context.chrome.bookmarks.getTree = () => Promise.reject(new Error("denied"));
  await settle();
  assert.deepEqual(broken.groupNames(), ["Most visited"], "A refused bookmark read falls through to the tiles");

  console.log("PASS newtab import: bookmarks bar seeding, top-sites fallback, starter set, merging imports");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
