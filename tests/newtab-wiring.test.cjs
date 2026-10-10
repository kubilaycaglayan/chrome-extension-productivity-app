const assert = require("node:assert/strict");
const fs = require("node:fs");

// The DOM tests stub elements by id, so check the real page actually has them.
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const page = fs.readFileSync("newtab/newtab.html", "utf8");
const script = fs.readFileSync("newtab/newtab.js", "utf8");
const css = fs.readFileSync("newtab/newtab.css", "utf8");
const popup = fs.readFileSync("popup/popup.js", "utf8");
const popupPage = fs.readFileSync("popup/popup.html", "utf8");

assert.equal(manifest.chrome_url_overrides?.newtab, "newtab/newtab.html");
for (const permission of ["storage", "favicon", "bookmarks", "topSites"]) {
  assert.ok(manifest.permissions.includes(permission), `The page needs the ${permission} permission`);
}
// Suggest and Backdrop are plain https fetches, covered by the existing hosts.
assert.ok(manifest.host_permissions.includes("<all_urls>"));

const assets = ["newtab.css", "../shared/module-defaults.js", "../content/module-settings.js", "../shared/newtab-settings.js", "../shared/newtab-wallpapers.js", "newtab.js"];
for (const asset of assets) {
  assert.ok(page.includes(asset), `newtab.html must load ${asset}`);
  const path = asset.startsWith("../") ? asset.slice(3) : `newtab/${asset}`;
  assert.ok(fs.existsSync(path), `${path} must exist`);
}
// Scripts must arrive in dependency order: the registry, then the helpers, then the page.
const order = assets.filter(asset => asset.endsWith(".js")).map(asset => page.indexOf(asset));
assert.deepEqual(order, [...order].sort((a, b) => a - b), "Script tags must stay in dependency order");

const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
for (const [, id] of script.matchAll(/element\("([^"]+)"\)/g)) {
  assert.ok(ids.has(id), `newtab.html is missing #${id}, which newtab.js looks up`);
}
assert.ok(script.includes('productivityModules.register("newtab"'), "The page must register as a module");
assert.ok(page.includes('id="notice"'), "A disabled page needs its explanatory notice");

// No status bar: announcements live in a visually hidden region.
assert.match(css, /#status \{[^}]*clip-path: inset\(50%\)/, "#status must stay visually hidden");
assert.doesNotMatch(css, /#status:not\(:empty\)/, "The old status bar styling must be gone");
assert.ok(page.includes('role="status"') && page.includes('aria-live="polite"'), "Announcements still need a live region");
for (const inline of ["background-message", "bookmark-error"]) {
  assert.ok(ids.has(inline), `#${inline} reports failures where they happen`);
  assert.ok(script.includes(`element("${inline}")`));
}

// Enter must save, not cancel: implicit submission activates the form's first
// submit button, so Save has to be the only one in each dialog.
for (const dialog of ["group", "bookmark"]) {
  const markup = page.match(new RegExp(`<dialog id="${dialog}-dialog">.*?</dialog>`, "s"))?.[0];
  assert.ok(markup, `newtab.html must contain the ${dialog} dialog`);
  const submits = [...markup.matchAll(/<button[^>]*type="submit"[^>]*>/g)].map(match => match[0]);
  assert.equal(submits.length, 1, `The ${dialog} dialog must have exactly one submit button, so Enter saves`);
  assert.match(submits[0], /value="save"/, `The ${dialog} dialog's submit button must save`);
  assert.match(markup, new RegExp(`id="${dialog}-cancel"[^>]*type="button"`), `${dialog} Cancel must not be a submit button`);
  assert.ok(script.includes(`${dialog === "group" ? "groupDialog" : "bookmarkDialog"}.close("cancel")`), `Cancel must close the ${dialog} dialog`);
}

// Combobox plumbing for both autocompletes.
for (const [field, list] of [["query", "suggestions"], ["bookmark-search", "bookmark-suggestions"]]) {
  assert.match(page, new RegExp(`id="${field}"[^>]*role="combobox"`, "s"), `#${field} must be a combobox`);
  assert.match(page, new RegExp(`id="${field}"[^>]*aria-controls="${list}"`, "s"));
  assert.match(page, new RegExp(`id="${list}"[^>]*role="listbox"`, "s"));
}

// First-run seeding and the manual import both read the browser's bookmarks.
assert.ok(ids.has("import-bookmarks"));
assert.ok(script.includes("chrome.bookmarks?.getTree"), "The import must degrade when the API is absent");
assert.ok(script.includes("chrome.topSites?.get"));
assert.ok(script.includes("settings.bookmarkGroups"));

// Tiles read like Chrome's own shortcuts: round favicon above a centred label,
// several to a row.
assert.match(css, /\.tiles \{[^}]*grid-template-columns: repeat\(auto-fill/, "Tiles must sit side by side in a grid");
assert.match(css, /\.favicon \{[^}]*border-radius: 50%/, "Favicons must be circular");
assert.match(css, /\.tile a, \.add-tile \{[^}]*flex-direction: column/, "The favicon sits above its label");
assert.ok(css.includes(".tile-actions"), "A tile's controls live in its corner");
assert.ok(script.includes('addIcon.className = "favicon add-icon"'), "The add control is a tile of its own");

// Dragging needs the hint and the styling that shows where a drop will land.
assert.ok(ids.has("drag-hint"));
for (const rule of [".group.dragging", ".tile.dragging", ".group.drop-into", ".tile.drop-before", ".group.drop-after"]) {
  assert.ok(css.includes(rule), `newtab.css must style ${rule}`);
}
assert.ok(script.includes("tile.draggable = editing"), "Tiles are only draggable while editing");
assert.ok(script.includes("handle.draggable = true"), "The group handle is the drag source");

// Edit mode: one switch for every control that changes the board.
assert.ok(ids.has("edit-toggle"));
assert.match(page, /id="edit-toggle"[^>]*aria-pressed="false"/s, "The edit toggle must start off and announce its state");
assert.ok(script.includes("function setEditing"), "The mode must live in one place");
assert.match(css, /#edit-toggle\[aria-pressed="true"\]/, "Edit mode has to look switched on");
for (const control of ["tile-actions", "add-tile", "handle"]) {
  assert.ok(script.includes(control), `newtab.js must build the ${control} control`);
}

// A photo must not tear the chooser out of its corner. Both it and its buttons
// are already fixed; `position: relative` would drop them into the page flow.
assert.doesNotMatch(css, /body\.has-image [^{\n]*#background-(?:panel|toggle)[^{\n]*\{[^}]*position: relative/,
  "The chooser must stay fixed over a photo");
assert.match(css, /#background-panel \{[^}]*position: fixed/);
assert.match(css, /#edit-toggle, #background-toggle \{[^}]*position: fixed/);

// Manage extensions: a shortcut beside the search field, wired through the
// tabs API because chrome:// is out of reach for a link.
assert.ok(ids.has("extensions-toggle"));
assert.match(page, /id="extensions-toggle"[^>]*hidden/s, "The shortcut stays hidden until the module mounts it");
assert.match(page, /id="extensions-toggle"[^>]*aria-label="Manage extensions"/s);
assert.match(page, /id="search-row"[\s\S]*?id="extensions-toggle"[\s\S]*?id="search-area"/,
  "The shortcut belongs beside the search field");
assert.match(css, /#extensions-toggle \{[^}]*flex: 0 0 42px/, "The shortcut keeps its width beside search");
assert.ok(script.includes('"chrome://extensions"'));
assert.ok(script.includes("chrome.tabs.update"), "A link cannot reach chrome://, so the page navigates the tab");
assert.ok(script.includes("chrome.tabs.create"), "A refused navigation must still land somewhere");
assert.ok(script.includes("chrome.tabs?.update"), "The shortcut must degrade when the API is absent");
assert.ok(manifest.permissions.includes("tabs"), "Navigating a tab needs the tabs permission");

// Gmail shortcuts: real links in the one corner the page leaves free, a
// column of them, each showing its account's email. What they can never be is
// a fetch from this page -- opening a new tab stays free of network calls, so
// the account list is the service worker's to find.
assert.ok(ids.has("mail-links"));
assert.match(page, /id="mail-links"[^>]*aria-label="Gmail accounts"/s, "The column of buttons needs a name of its own");
assert.match(page, /id="mail-links"[^>]*hidden/s, "The corner stays empty until the module mounts it");
assert.match(css, /#mail-links \{[^}]*position: fixed;[^}]*top: 20px;[^}]*right: 20px/, "The buttons belong in the top right corner");
assert.match(css, /#mail-links \{[^}]*flex-direction: column/, "One account per row, top to bottom");
assert.match(css, /\.mail-email \{[^}]*text-overflow: ellipsis/, "A long email is cut short rather than pushing the button off the page");
assert.match(css, /\.mail-email \{[^}]*font-size: 16px/, "The username is sized to be read at a glance -- as its own property, since `inherit` voids a font shorthand");
assert.match(css, /#tab-groups \{ right: max\(0px, calc\(var\(--mail-room/, "The chips stop short of the column");
assert.match(css, /#background-panel \{[^}]*max-height: min\([^;]*var\(--mail-bottom/, "The open chooser stops below the column");
assert.ok(script.includes("renderMailAccounts"), "The page must paint the accounts it finds in storage");
assert.ok(script.includes("data:image/svg+xml,"), "The envelope is drawn: the favicon cache has no icon for a site this profile has not collected one for");
assert.ok(script.includes("settings.mail.clean("), "A list out of storage must be sanitised before it becomes an href");
assert.ok(script.includes("changes[settings.mail.key]"), "An account found while a tab is open must show up without a reload");
assert.ok(script.includes("changes[settings.mail.hiddenKey]"), "...and so must one hidden from another tab");
assert.doesNotMatch(script, /fetch\([^)]*google\.com/, "The page must never ask Google itself");
assert.ok(fs.existsSync("modules/mail-accounts.js"), "The discovery belongs to the service worker");
assert.ok(fs.readFileSync("background/service-worker.js", "utf8").includes("initializeMailAccounts()"));
assert.ok(manifest.permissions.includes("declarativeNetRequestWithHostAccess"), "Stripping the Origin Google refuses takes a session rule");
assert.ok(manifest.host_permissions.includes("<all_urls>"), "Asking accounts.google.com for the list needs its host");

// Instead they are stacked explicitly, above the scrim and the page content.
const depth = (selector) => {
  const found = css.match(new RegExp(`${selector} \\{[^}]*z-index: (\\d+)`));
  assert.ok(found, `${selector} must declare a z-index`);
  return Number(found[1]);
};
const stack = ["body\\.has-image #scrim", "body\\.has-image #app", "#attribution", "#mail-links", "#edit-toggle, #background-toggle", "#background-panel"].map(depth);
assert.deepEqual(stack, [...new Set(stack)].sort((a, b) => a - b), "The scrim, page, credit, buttons and chooser must stack in that order");

// A scrollbar appearing must never shift what the pointer is aimed at: that is
// how a click on a wallpaper lands on the tile next to it instead.
assert.match(css, /html \{[^}]*scrollbar-gutter: stable/, "The page must reserve its scrollbar gutter");
assert.match(css, /#background-panel \{[^}]*scrollbar-gutter: stable/, "The chooser must reserve its scrollbar gutter");
assert.ok(script.includes("panel.scrollTop"), "Swapping wallpaper lists must bring the new list into view");
assert.match(css, /\.wallpaper\[aria-pressed="true"\] \{[^}]*outline:/, "The chosen wallpaper needs the marker the swatches have");

// The popup is the only place modules are toggled, and backups carry the data.
assert.match(popup, /\["newtab", "New Tab page",/);
assert.ok(popupPage.includes("../shared/newtab-settings.js"), "The popup needs the shared helpers for backups");
for (const fragment of ["newtabSettings.groupsKey", "newtabSettings.backgroundKey", "newtabSettings.cleanGroups", "newtabSettings.cleanBackground"]) {
  assert.ok(popup.includes(fragment), `popup.js must use ${fragment}`);
}

console.log("PASS newtab wiring: manifest, page assets, element ids, hidden status, combobox, import, drag styling, Gmail shortcuts, popup backups");
