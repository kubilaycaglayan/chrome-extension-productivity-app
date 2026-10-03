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
  page.tabGroupEvents.onRemoved.fire();
  await settle();
  assert.equal(strip.hidden, true, "The strip disappears when there are no Chrome tab groups");

  page.toggleModule(false);
  assert.equal(page.tabGroupEvents.onUpdated.listeners.size, 0, "Listeners leave with the new-tab module");
  console.log("PASS newtab tab groups: position, live groups, switching, empty state, cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
