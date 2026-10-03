const assert = require("node:assert/strict");
const fs = require("node:fs");
const { setup, fire, settle } = require("./newtab-dom.cjs");

(async () => {
  const html = fs.readFileSync("newtab/newtab.html", "utf8");
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.ok(manifest.permissions.includes("tabGroups"), "Chrome tab groups need their API permission");
  assert.ok(html.indexOf('id="tab-groups"') < html.indexOf('id="search-area"'));
  assert.ok(html.indexOf('id="search-area"') < html.indexOf('id="groups"'),
    "Chrome tab groups belong above search; bookmark groups remain below it");

  const browserGroups = [
    { id: 20, title: "Work", color: "blue", collapsed: true },
    { id: 10, title: "", color: "green", collapsed: false }
  ];
  const browserTabs = [
    { id: 101, groupId: 10, index: 0 },
    { id: 201, groupId: 20, index: 2 },
    { id: 202, groupId: 20, index: 3 }
  ];
  const page = setup({ browserGroups, browserTabs });
  await settle();

  const strip = page.element("tab-groups");
  assert.equal(strip.hidden, false);
  assert.deepEqual(strip.children.map(chip => chip.children[0].textContent), ["Untitled group", "Work"],
    "Groups follow their order in the Chrome tab strip");
  assert.deepEqual(strip.children.map(chip => chip.children[1].textContent), ["1", "2"]);
  assert.equal(strip.children[1].dataset.color, "blue");

  fire(strip.children[1], "click");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(page.tabGroupUpdates)), [{ groupId: 20, changes: { collapsed: false } }]);
  assert.deepEqual(page.tabUpdates, [201], "Clicking a group activates its first tab");

  browserTabs.splice(1, 1);
  page.tabGroupEvents.onUpdated.fire();
  await settle();
  assert.equal(strip.children[1].children[1].textContent, "1", "The live tab count updates");

  browserGroups.splice(0);
  browserTabs.splice(0);
  page.tabGroupEvents.onRemoved.fire();
  await settle();
  assert.equal(strip.hidden, true, "The strip disappears when there are no Chrome tab groups");

  page.toggleModule(false);
  assert.equal(page.tabGroupEvents.onUpdated.listeners.size, 0, "Listeners leave with the new-tab module");

  const withoutNewPermission = setup({
    browserTabs: [
      { id: 301, groupId: 42, index: 0 },
      { id: 302, groupId: 42, index: 1 },
      { id: 303, groupId: -1, index: 2 }
    ]
  });
  await settle();
  const fallback = withoutNewPermission.element("tab-groups");
  assert.equal(fallback.hidden, false, "Existing tabs permission can still reveal open groups");
  assert.deepEqual(fallback.children.map(chip => chip.children[0].textContent), ["Tab group 1"]);
  assert.equal(fallback.children[0].children[1].textContent, "2");
  fire(fallback.children[0], "click");
  await settle();
  assert.deepEqual(withoutNewPermission.tabUpdates, [301]);

  const allWindows = setup({
    browserGroups: [
      { id: 60, title: "Other window", color: "purple", collapsed: true, windowId: 2 },
      { id: 50, title: "This window", color: "blue", collapsed: false, windowId: 1 }
    ],
    browserTabs: [
      { id: 601, groupId: 60, index: 0, windowId: 2 },
      { id: 501, groupId: 50, index: 0, windowId: 1 }
    ]
  });
  await settle();
  const allChips = allWindows.element("tab-groups").children;
  assert.deepEqual(allChips.map(chip => chip.children[0].textContent), ["This window", "Other window"]);
  fire(allChips[1], "click");
  await settle();
  assert.deepEqual(allWindows.tabUpdates, [601]);
  assert.deepEqual(JSON.parse(JSON.stringify(allWindows.tabGroupUpdates)),
    [{ groupId: 60, changes: { collapsed: false } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(allWindows.windowUpdates)),
    [{ windowId: 2, changes: { focused: true } }]);

  console.log("PASS newtab tab groups: position, all windows, collapsed groups, switching, fallback, cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
