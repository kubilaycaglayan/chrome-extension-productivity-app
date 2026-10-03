const assert = require("node:assert/strict");
const { setup, fire, queryAll, dataTransfer, pressEnter, settle } = require("./newtab-dom.cjs");

function button(root, label) {
  return queryAll(root, "button").find(node => node.getAttribute("aria-label") === label || node.textContent === label);
}

// Walks a drag from one node to another, the way a pointer would.
function drag(from, to, { at = "before", axis = "x" } = {}) {
  const transfer = dataTransfer();
  fire(from, "dragstart", { dataTransfer: transfer });
  to.rect = { left: 0, top: 0, width: 200, height: 40 };
  const point = axis === "y"
    ? { clientY: at === "after" ? 30 : 10, clientX: 100 }
    : { clientX: at === "after" ? 150 : 50, clientY: 20 };
  const over = fire(to, "dragover", { dataTransfer: transfer, ...point });
  assert.ok(over.defaultPrevented, "A valid drop target must accept the drag");
  fire(to, "drop", { dataTransfer: transfer, ...point });
  fire(from, "dragend", { dataTransfer: transfer });
  return transfer;
}

(async () => {
  const suggestUrl = "https://suggestqueries.google.com/complete/search?client=firefox&hl=en-GB&q=chrome%20ext";
  const bookmarks = [
    { title: "Hacker News", url: "https://news.ycombinator.com/" },
    { title: "Chrome docs", url: "https://developer.chrome.com/docs/extensions" },
    { title: "A folder" },
    { title: "Already there", url: "https://github.com" },
    { title: "Bad scheme", url: "javascript:alert(1)" }
  ];
  const page = setup({
    bookmarks,
    responses: { [suggestUrl]: '["chrome ext",["chrome extensions","chrome extension store","chrome extension claude"],[],{}]' }
  });
  await settle();

  /* Mount and first-run groups */
  assert.equal(page.element("app").hidden, false, "The page mounts when the module is on");
  assert.equal(page.swatches().length, page.settings.colors.length + page.settings.gradients.length);
  assert.equal(page.element("query").focused, true);
  assert.deepEqual(page.groupNames(), ["Daily", "Dev"]);
  assert.deepEqual(page.tileLabels(0), ["Gmail", "Calendar", "Drive"]);

  /* Edit mode: a new tab opens as a plain board and the controls come on
     demand, so everything below has to switch it on first. */
  assert.equal(page.body.classList.contains("editing"), false, "A new tab opens out of edit mode");
  assert.equal(page.element("edit-toggle").getAttribute("aria-pressed"), "false");
  assert.equal(page.element("drag-hint").hidden, true, "The drag hint belongs to edit mode");
  assert.equal(page.tiles(0)[0].draggable, false, "Tiles only drag while editing");
  assert.equal(queryAll(page.cards()[0], "button").length, 0, "No rename, delete, handle or add button while reading");
  fire(page.element("edit-toggle"), "click");
  assert.equal(page.body.classList.contains("editing"), true);
  assert.equal(page.element("edit-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(page.element("edit-toggle").getAttribute("aria-label"), "Done editing");
  assert.equal(page.element("drag-hint").hidden, false);
  assert.equal(page.tiles(0)[0].draggable, true);
  assert.ok(button(page.cards()[0], "Rename Daily"), "Edit mode brings the group controls back");

  /* The manage-extensions shortcut: chrome:// pages cannot be reached from a
     link, so the click has to navigate this tab through the tabs API. */
  const manage = page.element("extensions-toggle");
  assert.equal(manage.hidden, false, "The shortcut shows once the page has mounted");
  fire(manage, "click");
  await settle();
  assert.deepEqual(page.tabUpdates, ["chrome://extensions"]);
  assert.deepEqual(page.tabOpens, [], "A navigation that worked must not also open a tab");

  const favicon = queryAll(page.tiles(0)[0], ".favicon")[0];
  assert.ok(favicon.src.startsWith("chrome-extension://productivity/_favicon/?pageUrl="));
  fire(favicon, "error");
  assert.equal(queryAll(page.tiles(0)[0], ".initial")[0].textContent, "G");

  /* Search suggestions come from Google's suggest service. */
  const query = page.element("query");
  query.value = "chrome ext";
  fire(query, "input");
  assert.equal(page.fetches.length, 0, "Suggestions must wait for the typing to settle");
  page.flushTimers();
  await settle();
  assert.deepEqual(page.fetches.map(call => call.url), [suggestUrl]);
  assert.equal(page.fetches[0].options.credentials, "omit", "Suggest requests must not carry cookies");
  assert.equal(page.element("suggestions").hidden, false);
  assert.deepEqual(page.options("suggestions").map(option => option.textContent),
    ["chrome extensions", "chrome extension store", "chrome extension claude"]);
  assert.equal(query.getAttribute("aria-expanded"), "true");

  /* Arrow keys walk the list, Enter searches the highlighted suggestion. */
  fire(query, "keydown", { key: "ArrowDown" });
  assert.equal(query.value, "chrome extensions");
  assert.equal(query.getAttribute("aria-activedescendant"), "suggestion-0");
  fire(query, "keydown", { key: "ArrowDown" });
  assert.equal(query.value, "chrome extension store");
  fire(query, "keydown", { key: "ArrowUp" });
  assert.equal(query.value, "chrome extensions");
  fire(page.element("search"), "submit");
  assert.deepEqual(page.navigations, ["https://www.google.com/search?q=chrome%20extensions"]);
  assert.equal(page.element("suggestions").hidden, true, "Submitting closes the list");

  /* Escape restores what was typed. */
  query.value = "chrome ext";
  fire(query, "input");
  page.flushTimers();
  await settle();
  fire(query, "keydown", { key: "ArrowDown" });
  assert.equal(query.value, "chrome extensions");
  fire(query, "keydown", { key: "Escape" });
  assert.equal(query.value, "chrome ext", "Escape puts the typed text back");
  assert.equal(page.element("suggestions").hidden, true);

  /* Typing nothing asks for nothing. */
  const quietFetches = page.fetches.length;
  query.value = "   ";
  fire(query, "input");
  page.flushTimers();
  await settle();
  assert.equal(page.fetches.length, quietFetches, "A blank query must not hit the network");

  /* Adding a bookmark autocompletes from the browser's own bookmarks. */
  fire(button(page.cards()[1], "Add bookmark to Dev"), "click");
  await settle();
  assert.equal(page.element("bookmark-dialog").open, true);
  const search = page.element("bookmark-search");
  search.value = "news";
  fire(search, "input");
  page.flushTimers();
  await settle();
  assert.equal(page.element("bookmark-suggestions").hidden, false);
  const matches = page.options("bookmark-suggestions");
  assert.deepEqual(matches.map(option => option.children[0].textContent), ["Hacker News", "Chrome docs"],
    "Folders, unusable schemes and bookmarks already in the group are left out");
  assert.deepEqual(matches.map(option => option.children[1].textContent), ["news.ycombinator.com", "developer.chrome.com"]);

  fire(search, "keydown", { key: "ArrowDown" });
  assert.equal(matches[0].getAttribute("aria-selected"), "true");
  fire(search, "keydown", { key: "Enter" });
  assert.equal(page.element("bookmark-label").value, "Hacker News");
  assert.equal(page.element("bookmark-url").value, "https://news.ycombinator.com/");
  assert.equal(page.element("bookmark-suggestions").hidden, true);
  assert.equal(page.element("bookmark-dialog").open, true, "Picking a match must not close the dialog");
  assert.equal(page.element("bookmark-url").focused, true, "Focus moves on so the next Enter saves");

  /* Enter in a field saves, because Save is the form's only submit button. */
  pressEnter(page.element("bookmark-dialog"), page.element("bookmark-url"));
  await settle();
  assert.deepEqual(page.tileLabels(1), ["GitHub", "Hugging Face", "Stack Overflow", "Hacker News"]);

  /* Enter in the search field takes the first match when none is highlighted. */
  fire(button(page.cards()[1], "Add bookmark to Dev"), "click");
  await settle();
  search.value = "chrome";
  fire(search, "input");
  page.flushTimers();
  await settle();
  assert.deepEqual(page.options("bookmark-suggestions").map(option => option.children[0].textContent), ["Chrome docs"],
    "The bookmark just added is no longer offered");
  fire(search, "keydown", { key: "Enter" });
  assert.equal(page.element("bookmark-url").value, "https://developer.chrome.com/docs/extensions");
  pressEnter(page.element("bookmark-dialog"), page.element("bookmark-label"));
  await settle();
  assert.deepEqual(page.tileLabels(1), ["GitHub", "Hugging Face", "Stack Overflow", "Hacker News", "Chrome docs"]);

  /* Cancel closes without saving. */
  const beforeCancel = page.writes.length;
  fire(button(page.cards()[1], "Add bookmark to Dev"), "click");
  await settle();
  page.element("bookmark-url").value = "https://example.com";
  fire(page.element("bookmark-cancel"), "click");
  await settle();
  assert.equal(page.element("bookmark-dialog").open, false);
  assert.equal(page.writes.length, beforeCancel, "Cancelling writes nothing");
  assert.equal(page.tiles(1).length, 5);

  /* New groups use the inline form. The dialog handles renaming. */
  page.element("new-group-name").value = "Reading";
  fire(page.element("new-group"), "submit");
  await settle();
  assert.deepEqual(page.groupNames(), ["Daily", "Dev", "Reading"]);
  assert.equal(page.element("new-group-name").value, "", "The inline field clears after adding a group");
  fire(button(page.cards()[2], "Rename Reading"), "click");
  await settle();
  page.element("group-name").value = "Discarded";
  fire(page.element("group-cancel"), "click");
  await settle();
  assert.deepEqual(page.groupNames(), ["Daily", "Dev", "Reading"], "A cancelled rename leaves the group unchanged");

  /* Deleting it again leaves the page as it was. */
  fire(button(page.cards()[2], "Delete Reading"), "click");
  await settle();
  assert.deepEqual(page.groupNames(), ["Daily", "Dev"]);

  /* A rejected address reports inline instead of in a bar. */
  fire(button(page.cards()[1], "Add bookmark to Dev"), "click");
  await settle();
  page.element("bookmark-url").value = "javascript:alert(1)";
  page.element("bookmark-dialog").returnValue = "save";
  page.element("bookmark-dialog").close();
  await settle();
  assert.equal(page.element("bookmark-error").hidden, false);
  assert.ok(page.element("bookmark-error").textContent.includes("could not be used"));
  assert.equal(page.tiles(1).length, 5, "Nothing is added when the address is unusable");

  /* Dragging a tile within its group. */
  drag(page.tiles(0)[0], page.tiles(0)[2], { at: "after" });
  await settle();
  assert.deepEqual(page.tileLabels(0), ["Calendar", "Drive", "Gmail"]);
  assert.deepEqual(page.store[page.settings.groupsKey][0].bookmarks.map(b => b.label), ["Calendar", "Drive", "Gmail"]);

  drag(page.tiles(0)[2], page.tiles(0)[0], { at: "before" });
  await settle();
  assert.deepEqual(page.tileLabels(0), ["Gmail", "Calendar", "Drive"]);

  /* Dragging a tile into another group's card. */
  drag(page.tiles(0)[1], page.cards()[1]);
  await settle();
  assert.deepEqual(page.tileLabels(0), ["Gmail", "Drive"]);
  assert.deepEqual(page.tileLabels(1), ["GitHub", "Hugging Face", "Stack Overflow", "Hacker News", "Chrome docs", "Calendar"]);

  /* Dropping onto a specific tile in another group lands at that position. */
  drag(page.tiles(1).at(-1), page.tiles(0)[0], { at: "before" });
  await settle();
  assert.deepEqual(page.tileLabels(0), ["Calendar", "Gmail", "Drive"]);
  assert.equal(page.tiles(1).length, 5);

  /* Dragging a group by its handle. */
  const handle = queryAll(page.cards()[0], ".handle")[0];
  drag(handle, page.cards()[1], { at: "after", axis: "x" });
  await settle();
  assert.deepEqual(page.groupNames(), ["Dev", "Daily"]);
  assert.deepEqual(page.store[page.settings.groupsKey].map(group => group.name), ["Dev", "Daily"]);

  /* Keyboard reordering, for anyone not using a mouse. */
  fire(queryAll(page.cards()[1], ".handle")[0], "keydown", { key: "ArrowLeft" });
  await settle();
  assert.deepEqual(page.groupNames(), ["Daily", "Dev"]);
  assert.equal(queryAll(page.cards()[0], ".handle")[0].focused, true, "Focus follows the moved group");
  fire(queryAll(page.cards()[0], ".handle")[0], "keydown", { key: "End" });
  await settle();
  assert.deepEqual(page.groupNames(), ["Dev", "Daily"]);

  const tileLink = queryAll(page.tiles(1)[0], "a")[0];
  fire(tileLink, "keydown", { key: "ArrowRight", altKey: true });
  await settle();
  assert.deepEqual(page.tileLabels(1), ["Gmail", "Calendar", "Drive"]);
  fire(queryAll(page.tiles(1)[1], "a")[0], "keydown", { key: "ArrowUp", altKey: true });
  await settle();
  assert.equal(page.tileLabels(1).length, 2);
  assert.ok(page.tileLabels(0).includes("Calendar"), "Alt+Up hands the tile to the previous group");
  assert.equal(page.store[page.settings.groupsKey][0].bookmarks.at(-1).label, "Calendar", "The move is saved");

  /* Plain arrow keys on a tile are left to the browser. */
  const untouched = page.tileLabels(1).join();
  fire(queryAll(page.tiles(1)[0], "a")[0], "keydown", { key: "ArrowRight" });
  assert.equal(page.tileLabels(1).join(), untouched);

  /* A refused navigation opens a tab instead, and a browser without the tabs
     API hides the shortcut rather than leaving a dead button on the page. */
  const refusing = setup({ tabs: { refuseUpdate: true } });
  await settle();
  fire(refusing.element("extensions-toggle"), "click");
  await settle();
  assert.deepEqual(refusing.tabOpens, ["chrome://extensions"], "The fallback opens the page in its own tab");

  const noTabs = setup({ tabs: null });
  await settle();
  assert.equal(noTabs.element("extensions-toggle").hidden, true, "No tabs API, no shortcut");

  console.log("PASS newtab page: mount, suggestions, bookmark autocomplete, manage-extensions shortcut, tile and group dragging, keyboard moves");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
