// New Tab page. Mounts when the module is enabled and tears itself down when
// it is switched off, so the page falls back to a plain notice instead of a
// half-wired UI.
productivityModules.register("newtab", () => {
  const settings = globalThis.newtabSettings;
  const wallpapers = globalThis.newtabWallpapers;
  const TILE_TYPE = "application/x-productivity-tile";
  const GROUP_TYPE = "application/x-productivity-group";
  const EXTENSIONS_URL = "chrome://extensions";

  const element = id => document.getElementById(id);
  const app = element("app");
  const form = element("search");
  const query = element("query");
  const suggestionList = element("suggestions");
  const tabGroupList = element("tab-groups");
  const groupList = element("groups");
  const newGroupForm = element("new-group");
  const newGroupName = element("new-group-name");
  const importBookmarks = element("import-bookmarks");
  const editToggle = element("edit-toggle");
  const extensionsToggle = element("extensions-toggle");
  const mailLinks = element("mail-links");
  const panel = element("background-panel");
  const panelToggle = element("background-toggle");
  const panelMessage = element("background-message");
  const colorSwatches = element("color-swatches");
  const gradientSwatches = element("gradient-swatches");
  const collectionList = element("wallpaper-collections");
  const wallpaperList = element("wallpaper-images");
  const wallpaperBack = element("wallpaper-back");
  const imageInput = element("background-image");
  const resetBackground = element("background-reset");
  const groupDialog = element("group-dialog");
  const groupCancel = element("group-cancel");
  const groupName = element("group-name");
  const bookmarkDialog = element("bookmark-dialog");
  const bookmarkCancel = element("bookmark-cancel");
  const bookmarkSearch = element("bookmark-search");
  const bookmarkSuggestions = element("bookmark-suggestions");
  const bookmarkLabel = element("bookmark-label");
  const bookmarkUrl = element("bookmark-url");
  const bookmarkError = element("bookmark-error");
  const attribution = element("attribution");
  const status = element("status");

  const language = chrome.i18n?.getUILanguage?.() || "en-US";
  // The page follows the OS theme. `matchMedia` is missing under test, where
  // the dark baseline is what the assertions expect.
  const lightQuery = globalThis.matchMedia?.("(prefers-color-scheme: light)") ?? null;
  const scheme = () => (lightQuery?.matches ? "light" : "dark");
  const pixelRatio = globalThis.devicePixelRatio || 1;
  const wallpaperWidth = Math.min(3840, Math.round((globalThis.screen?.width || 1920) * pixelRatio));
  const wallpaperHeight = Math.min(2160, Math.round((globalThis.screen?.height || 1080) * pixelRatio));

  let active = true;
  // A new tab opens as a clean board: the editing controls stay out of the way
  // until they are asked for.
  let editing = false;
  let mailAccounts = [];
  let mailHidden = [];
  let groups = [];
  let background = settings.defaultBackground;
  let collections = [];
  let dragged = null;
  let focusAfterRender = null;
  let statusTimer;
  let tabGroupRevision = 0;
  const tabGroupWatchers = [];
  const groupSizer = typeof ResizeObserver === "function"
    ? new ResizeObserver(entries => {
      for (const { target } of entries) sizeGroup(target);
    })
    : null;

  // The masonry grid uses 4px rows. Reserve 16px after each card to match
  // the space between columns, including when a card grows after rendering.
  function sizeGroup(card) {
    const rows = Math.max(1, Math.ceil((card.getBoundingClientRect().height + 16) / 4));
    card.style.gridRowEnd = `span ${rows}`;
  }

  if (groupSizer) groupList.classList.add("masonry");

  async function refreshTabGroups() {
    if (!chrome.tabs?.query) return;
    const revision = ++tabGroupRevision;
    try {
      const currentTab = await chrome.tabs.getCurrent?.();
      const currentWindowId = currentTab?.windowId
        ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.windowId;
      const [tabs, browserGroups] = await Promise.all([
        chrome.tabs.query({}),
        chrome.tabGroups?.query
          ? Promise.resolve().then(() => chrome.tabGroups.query({})).catch(() => [])
          : Promise.resolve([])
      ]);
      if (!active || revision !== tabGroupRevision) return;

      const metadata = new Map(browserGroups.map(group => [group.id, group]));
      const groupedTabs = new Map();
      for (const tab of tabs.sort((a, b) => a.index - b.index)) {
        if (!Number.isInteger(tab.groupId) || tab.groupId < 0) continue;
        if (!groupedTabs.has(tab.groupId)) groupedTabs.set(tab.groupId, []);
        groupedTabs.get(tab.groupId).push(tab);
      }
      const visible = [...groupedTabs].map(([id, members], index) => ({
        group: metadata.get(id) ?? { id, title: `Tab group ${index + 1}`, color: "grey" },
        members
      })).sort((a, b) => {
        const aWindow = a.group.windowId ?? a.members[0].windowId;
        const bWindow = b.group.windowId ?? b.members[0].windowId;
        if (aWindow === currentWindowId && bWindow !== currentWindowId) return -1;
        if (bWindow === currentWindowId && aWindow !== currentWindowId) return 1;
        return (aWindow ?? 0) - (bWindow ?? 0) || a.members[0].index - b.members[0].index;
      });

      tabGroupList.replaceChildren(...visible.map(({ group, members }) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "tab-group-chip";
        chip.dataset.color = group.color;
        const title = group.title?.trim() || "Untitled group";
        chip.setAttribute("aria-label", `${title}, ${members.length} tabs. Switch to group.`);
        const name = document.createElement("span");
        name.className = "tab-group-title";
        name.textContent = title;
        const count = document.createElement("span");
        count.className = "tab-group-count";
        count.textContent = String(members.length);
        chip.append(name, count);
        chip.addEventListener("click", async () => {
          try {
            if (group.collapsed && chrome.tabGroups?.update) {
              await chrome.tabGroups.update(group.id, { collapsed: false });
            }
            await chrome.tabs.update(members[0].id, { active: true });
            const targetWindowId = group.windowId ?? members[0].windowId;
            if (targetWindowId != null && targetWindowId !== currentWindowId) {
              await chrome.windows?.update?.(targetWindowId, { focused: true });
            }
          } catch {
            void refreshTabGroups();
          }
        });
        return chip;
      }));
      tabGroupList.hidden = !visible.length;
    } catch {
      if (active && revision === tabGroupRevision) {
        tabGroupList.replaceChildren();
        tabGroupList.hidden = true;
      }
    }
  }

  function watchTabGroups(event) {
    if (!event?.addListener) return;
    const listener = () => { void refreshTabGroups(); };
    event.addListener(listener);
    tabGroupWatchers.push(() => event.removeListener?.(listener));
  }

  // Announcements stay in the live region: the page shows no status bar.
  function setStatus(message) {
    status.textContent = message;
    clearTimeout(statusTimer);
    if (message) statusTimer = setTimeout(() => { status.textContent = ""; }, 4000);
  }

  function setMessage(node, message) {
    node.textContent = message;
    node.hidden = !message;
  }

  async function persist(values, message) {
    try {
      await chrome.storage.local.set(values);
      if (message) setStatus(message);
    } catch {
      setStatus("Could not save. Your change may be lost when this tab closes.");
    }
  }

  function saveGroups(message) {
    return persist({ [settings.groupsKey]: groups }, message);
  }

  /* Background */

  function applyBackground() {
    const theme = scheme();
    const css = settings.backgroundCss(background, wallpaperWidth, wallpaperHeight, theme);
    document.body.style.backgroundColor = css.color;
    document.body.style.backgroundImage = css.image;
    document.body.classList.toggle("has-image", css.scrim);
    // A swatch is identified by the preset's canonical value and shows the
    // face of it the current theme would paint, so the marked one stays
    // marked when the theme flips under it.
    for (const swatch of panel.querySelectorAll(".swatch")) {
      swatch.style.background = settings.presetFace(swatch.dataset.value, theme);
      swatch.setAttribute("aria-checked", String(swatch.dataset.value === background.value));
    }
    // Collection tiles carry no value: they open a list rather than pick one.
    for (const tile of panel.querySelectorAll(".wallpaper")) {
      if (tile.dataset.value) tile.setAttribute("aria-pressed", String(tile.dataset.value === background.value));
    }
    renderAttribution();
  }

  function renderAttribution() {
    attribution.replaceChildren();
    const credit = [background.label, background.credit].filter(Boolean).join(" — ");
    attribution.hidden = !credit;
    if (!credit) return;
    if (background.link) {
      const link = document.createElement("a");
      link.href = background.link;
      link.textContent = credit;
      link.rel = "noreferrer";
      attribution.append(link);
    } else {
      attribution.textContent = credit;
    }
  }

  function chooseBackground(value, message) {
    background = settings.cleanBackground(value);
    applyBackground();
    return persist({ [settings.backgroundKey]: background }, message);
  }

  function buildSwatches(container, presets, type) {
    container.replaceChildren(...presets.map(([name, value]) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-label", name);
      swatch.setAttribute("aria-checked", "false");
      swatch.title = name;
      swatch.dataset.value = value;
      swatch.style.background = settings.presetFace(value, scheme());
      swatch.addEventListener("click", () => {
        if (!active) return;
        void chooseBackground({ type, value }, `Background set to ${name}.`);
      });
      return swatch;
    }));
  }

  // Uploads are downscaled before storage so a 12MP photo cannot fill the
  // extension's storage quota.
  async function useImageFile(file) {
    if (!file) return;
    setMessage(panelMessage, "Preparing image…");
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, settings.limits.imagePixels / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      let dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      if (dataUrl.length > settings.limits.imageBytes) dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      if (!active) return;
      if (dataUrl.length > settings.limits.imageBytes) {
        setMessage(panelMessage, "That image is too large. Try one under 4 MB.");
        return;
      }
      setMessage(panelMessage, "");
      await chooseBackground({ type: "image", value: dataUrl }, "Background image saved.");
    } catch {
      setMessage(panelMessage, "Could not read that image. Choose a PNG, JPEG, or WebP file.");
    }
  }

  /* Google wallpapers, from the same Backdrop service Chrome's own New Tab uses */

  // `value` is the wallpaper this tile would set, left empty for the tiles that
  // only open a collection.
  function wallpaperTile(url, name, onPick, value = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wallpaper";
    button.title = name;
    if (value) {
      button.dataset.value = value;
      button.setAttribute("aria-pressed", String(value === background.value));
    }
    const thumbnail = document.createElement("img");
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    thumbnail.src = wallpapers.sized(url, 120, 68);
    const caption = document.createElement("span");
    caption.textContent = name;
    button.append(thumbnail, caption);
    button.setAttribute("aria-label", name);
    button.addEventListener("click", onPick);
    return button;
  }

  // Each swap changes the panel's height. Without this the panel can stay
  // scrolled where the old list ended and the new one looks like nothing
  // happened at all.
  function scrollToWallpapers() {
    const top = element("wallpaper-section").offsetTop;
    if (typeof top === "number") panel.scrollTop = Math.max(0, top - 8);
  }

  function showCollections() {
    wallpaperList.hidden = true;
    wallpaperBack.hidden = true;
    collectionList.hidden = false;
    collectionList.replaceChildren(...collections.map(collection =>
      wallpaperTile(collection.preview, collection.name, () => void openCollection(collection))));
    scrollToWallpapers();
  }

  async function openCollection(collection) {
    setMessage(panelMessage, `Loading ${collection.name}…`);
    let images = [];
    try {
      images = await wallpapers.images(collection.id, language);
    } catch {
      setMessage(panelMessage, `Could not load ${collection.name}.`);
      return;
    }
    if (!active) return;
    setMessage(panelMessage, "");
    collectionList.hidden = true;
    wallpaperBack.hidden = false;
    wallpaperList.hidden = false;
    wallpaperList.replaceChildren(...images.map(image =>
      wallpaperTile(image.url, image.label || collection.name, () => void chooseBackground(
        { type: "google", value: image.url, label: image.label, credit: image.credit, link: image.link },
        `Background set to ${image.label || collection.name}.`
      ), image.url)));
    scrollToWallpapers();
    if (!images.length) setMessage(panelMessage, `${collection.name} has no wallpapers right now.`);
  }

  // Fetched only when the chooser is opened, and cached for a day, so an
  // ordinary new tab never touches the network.
  async function loadCollections() {
    if (collections.length) return;
    let cached;
    try {
      cached = (await chrome.storage.local.get(wallpapers.cacheKey))[wallpapers.cacheKey];
    } catch {
      cached = null;
    }
    if (!active) return;
    if (Array.isArray(cached?.collections) && Date.now() - cached.fetchedAt < wallpapers.cacheMaxAge) {
      collections = cached.collections;
      showCollections();
      return;
    }
    setMessage(panelMessage, "Loading Google's wallpapers…");
    try {
      const fetched = await wallpapers.collections(language);
      if (!active) return;
      collections = fetched;
      showCollections();
      setMessage(panelMessage, fetched.length ? "" : "Google returned no wallpapers.");
      await chrome.storage.local.set({ [wallpapers.cacheKey]: { fetchedAt: Date.now(), collections: fetched } });
    } catch {
      if (active) setMessage(panelMessage, "Could not reach Google's wallpapers. The presets above still work.");
    }
  }

  /* Search suggestions, from the service the omnibox uses */

  let typedQuery = "";
  let suggestions = [];
  let activeSuggestion = -1;
  let suggestTimer;
  let suggestRequest;

  function closeSuggestions() {
    suggestions = [];
    activeSuggestion = -1;
    suggestionList.replaceChildren();
    suggestionList.hidden = true;
    query.setAttribute("aria-expanded", "false");
    query.removeAttribute("aria-activedescendant");
  }

  function highlightSuggestion(index) {
    activeSuggestion = index;
    const options = suggestionList.children;
    for (let position = 0; position < options.length; position++) {
      const selected = position === index;
      options[position].setAttribute("aria-selected", String(selected));
      options[position].classList.toggle("active", selected);
    }
    if (index < 0) {
      query.value = typedQuery;
      query.removeAttribute("aria-activedescendant");
      return;
    }
    query.value = suggestions[index];
    query.setAttribute("aria-activedescendant", options[index].id);
  }

  function renderSuggestions(items) {
    suggestions = items;
    activeSuggestion = -1;
    if (!items.length) {
      closeSuggestions();
      return;
    }
    suggestionList.replaceChildren(...items.map((text, index) => {
      const option = document.createElement("li");
      option.id = `suggestion-${index}`;
      option.className = "suggestion";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.textContent = text;
      // mousedown, so the click is not lost to the field's blur.
      option.addEventListener("mousedown", event => {
        event.preventDefault();
        navigate(text);
      });
      return option;
    }));
    suggestionList.hidden = false;
    query.setAttribute("aria-expanded", "true");
  }

  async function requestSuggestions(text) {
    const url = settings.suggestUrl(text, language);
    if (!url) {
      closeSuggestions();
      return;
    }
    suggestRequest?.abort();
    suggestRequest = new AbortController();
    try {
      const response = await fetch(url, { signal: suggestRequest.signal, credentials: "omit", cache: "no-store" });
      const payload = await response.text();
      if (!active || query.value.trim() !== text.trim()) return;
      renderSuggestions(settings.parseSuggestions(payload));
    } catch {
      // Offline, blocked, or superseded: typing and searching still work.
    }
  }

  function onQueryInput() {
    typedQuery = query.value;
    clearTimeout(suggestTimer);
    const text = query.value;
    if (!text.trim()) {
      closeSuggestions();
      return;
    }
    suggestTimer = setTimeout(() => requestSuggestions(text), 140);
  }

  function navigate(text) {
    const target = settings.searchUrl(text);
    if (target) location.assign(target);
  }

  function onQueryKeyDown(event) {
    if (event.key === "Escape" && suggestions.length) {
      event.stopPropagation();
      highlightSuggestion(-1);
      closeSuggestions();
      return;
    }
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlightSuggestion(activeSuggestion + 1 >= suggestions.length ? -1 : activeSuggestion + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlightSuggestion(activeSuggestion <= -1 ? suggestions.length - 1 : activeSuggestion - 1);
    } else if (event.key === "Tab") {
      closeSuggestions();
    }
  }

  function onSubmit(event) {
    event.preventDefault();
    clearTimeout(suggestTimer);
    closeSuggestions();
    navigate(query.value);
  }

  /* Bookmark dialog, with autocomplete over the browser's own bookmarks */

  let bookmarkMatches = [];
  let activeMatch = -1;
  let bookmarkTimer;
  let bookmarkContext = null;

  function closeBookmarkSuggestions() {
    bookmarkMatches = [];
    activeMatch = -1;
    bookmarkSuggestions.replaceChildren();
    bookmarkSuggestions.hidden = true;
    bookmarkSearch.setAttribute("aria-expanded", "false");
    bookmarkSearch.removeAttribute("aria-activedescendant");
  }

  function highlightMatch(index) {
    activeMatch = index;
    const options = bookmarkSuggestions.children;
    for (let position = 0; position < options.length; position++) {
      const selected = position === index;
      options[position].setAttribute("aria-selected", String(selected));
      options[position].classList.toggle("active", selected);
    }
    if (index < 0) bookmarkSearch.removeAttribute("aria-activedescendant");
    else bookmarkSearch.setAttribute("aria-activedescendant", options[index].id);
  }

  function useMatch(match) {
    bookmarkLabel.value = match.label;
    bookmarkUrl.value = match.url;
    bookmarkSearch.value = match.label;
    setMessage(bookmarkError, "");
    closeBookmarkSuggestions();
    bookmarkUrl.focus();
  }

  function renderBookmarkMatches(matches) {
    bookmarkMatches = matches;
    activeMatch = -1;
    if (!matches.length) {
      closeBookmarkSuggestions();
      return;
    }
    bookmarkSuggestions.replaceChildren(...matches.map((match, index) => {
      const option = document.createElement("li");
      option.id = `bookmark-match-${index}`;
      option.className = "suggestion";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      const name = document.createElement("span");
      name.className = "match-label";
      name.textContent = match.label;
      const host = document.createElement("span");
      host.className = "match-url";
      host.textContent = settings.labelFor(match.url);
      option.append(name, host);
      option.addEventListener("mousedown", event => {
        event.preventDefault();
        useMatch(match);
      });
      return option;
    }));
    bookmarkSuggestions.hidden = false;
    bookmarkSearch.setAttribute("aria-expanded", "true");
  }

  async function searchBookmarks(text, group) {
    if (!chrome.bookmarks?.search || !text.trim()) {
      closeBookmarkSuggestions();
      return;
    }
    let nodes = [];
    try {
      nodes = await chrome.bookmarks.search({ query: text.trim() });
    } catch {
      return;
    }
    if (!active) return;
    const taken = new Set(group?.bookmarks.map(bookmark => bookmark.url) ?? []);
    const seen = new Set();
    const matches = [];
    for (const node of nodes) {
      const url = settings.cleanUrl(node.url);
      if (!url || taken.has(url) || seen.has(url)) continue;
      seen.add(url);
      matches.push({ label: (node.title || settings.labelFor(url)).slice(0, settings.limits.label), url });
      if (matches.length >= settings.limits.suggestions) break;
    }
    renderBookmarkMatches(matches);
  }

  // Save is each dialog's only submit button, so Enter in any field saves.
  // Cancel closes without submitting.
  function onGroupCancel() {
    groupDialog.close("cancel");
  }

  function onBookmarkCancel() {
    bookmarkDialog.close("cancel");
  }

  function askDialog(dialog) {
    return new Promise((resolve) => {
      const onClose = () => {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue);
      };
      dialog.addEventListener("close", onClose);
      dialog.returnValue = "cancel";
      dialog.showModal();
    });
  }

  // Renaming is the dialog's only job; new groups come from the inline form,
  // which is already a group-shaped card on the board.
  async function renameGroup(group) {
    element("group-dialog-title").textContent = "Rename group";
    groupName.value = group.name;
    if (await askDialog(groupDialog) !== "save" || !active) return;
    const value = groupName.value.trim().slice(0, settings.limits.name);
    if (!value) return;
    group.name = value;
    await saveGroups(`Group renamed to ${value}.`);
    render();
  }

  async function addGroupNamed(name) {
    const value = name.trim().slice(0, settings.limits.name);
    if (!value) {
      newGroupName.focus();
      return;
    }
    if (groups.length >= settings.limits.groups) {
      setStatus(`You can keep up to ${settings.limits.groups} groups.`);
      return;
    }
    groups.push({ id: settings.randomId(), name: value, bookmarks: [] });
    newGroupName.value = "";
    render();
    // The form outlives the render, so focus can stay put for the next name.
    newGroupName.focus();
    await saveGroups(`Group ${value} added.`);
  }

  async function editBookmark(group, bookmark) {
    element("bookmark-dialog-title").textContent = bookmark ? "Edit bookmark" : "Add bookmark";
    bookmarkLabel.value = bookmark?.label ?? "";
    bookmarkUrl.value = bookmark?.url ?? "";
    bookmarkSearch.value = "";
    setMessage(bookmarkError, "");
    closeBookmarkSuggestions();
    bookmarkContext = group;
    if (await askDialog(bookmarkDialog) !== "save" || !active) return;
    const address = settings.cleanUrl(bookmarkUrl.value);
    if (!address) {
      setMessage(bookmarkError, "That address could not be used. Enter a web address such as example.com.");
      setStatus("That address could not be used.");
      return;
    }
    const [entry] = settings.cleanBookmarks([{ id: bookmark?.id, label: bookmarkLabel.value, url: address }]);
    if (bookmark) {
      Object.assign(bookmark, entry);
      await saveGroups(`${entry.label} updated.`);
    } else if (group.bookmarks.length >= settings.limits.bookmarks) {
      setStatus(`${group.name} is full at ${settings.limits.bookmarks} bookmarks.`);
      return;
    } else {
      group.bookmarks.push(entry);
      await saveGroups(`${entry.label} added to ${group.name}.`);
    }
    render();
  }

  /* Moving things about */

  function groupIndex(id) {
    return groups.findIndex(group => group.id === id);
  }

  function moveGroup(id, insertAt) {
    const from = groupIndex(id);
    if (from < 0) return false;
    const next = settings.reorder(groups, from, insertAt);
    if (next === groups) return false;
    groups = next;
    focusAfterRender = { kind: "group", groupId: id };
    render();
    void saveGroups(`${groups[groupIndex(id)].name} moved.`);
    return true;
  }

  function moveBookmark(source, targetGroupId, insertAt) {
    const fromGroup = groups[groupIndex(source.groupId)];
    const toGroup = groups[groupIndex(targetGroupId)];
    if (!fromGroup || !toGroup) return false;
    const from = fromGroup.bookmarks.findIndex(bookmark => bookmark.id === source.bookmarkId);
    if (from < 0) return false;
    if (fromGroup === toGroup) {
      const next = settings.reorder(fromGroup.bookmarks, from, insertAt);
      if (next === fromGroup.bookmarks) return false;
      fromGroup.bookmarks = next;
    } else {
      if (toGroup.bookmarks.length >= settings.limits.bookmarks) {
        setStatus(`${toGroup.name} is full at ${settings.limits.bookmarks} bookmarks.`);
        return false;
      }
      const [source2, target] = settings.transfer(fromGroup.bookmarks, from, toGroup.bookmarks, insertAt);
      fromGroup.bookmarks = source2;
      toGroup.bookmarks = target;
    }
    focusAfterRender = { kind: "tile", bookmarkId: source.bookmarkId };
    render();
    void saveGroups("Bookmark moved.");
    return true;
  }

  function clearDropHints() {
    for (const node of groupList.querySelectorAll(".drop-before")) node.classList.remove("drop-before");
    for (const node of groupList.querySelectorAll(".drop-after")) node.classList.remove("drop-after");
    for (const node of groupList.querySelectorAll(".drop-into")) node.classList.remove("drop-into");
  }

  function dropSide(event, node, axis) {
    const box = node.getBoundingClientRect?.();
    if (!box) return "before";
    return axis === "x"
      ? (event.clientX > box.left + box.width / 2 ? "after" : "before")
      : (event.clientY > box.top + box.height / 2 ? "after" : "before");
  }

  function markDrop(node, side) {
    clearDropHints();
    node.classList.add(side === "after" ? "drop-after" : "drop-before");
  }

  /* Rendering */

  function faviconElement(url, label) {
    const icon = document.createElement("img");
    icon.className = "favicon";
    icon.alt = "";
    icon.width = 44;
    icon.height = 44;
    icon.src = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=64`);
    icon.addEventListener("error", () => {
      const initial = document.createElement("span");
      initial.className = "favicon initial";
      initial.setAttribute("aria-hidden", "true");
      initial.textContent = (label || settings.labelFor(url)).trim().charAt(0) || "?";
      icon.replaceWith(initial);
    });
    return icon;
  }

  // Gmail's envelope, drawn rather than fetched. The favicon service only
  // answers for a site this profile has already collected an icon for, and a
  // grey globe in the corner is no kind of shortcut.
  const MAIL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
    + '<path fill="#ea4335" d="M22 6.5v11c0 .83-.67 1.5-1.5 1.5H19V9.8l-7 5.1-7-5.1V19H3.5c-.83 0-1.5-.67-1.5-1.5v-11c0-1.2 1.36-1.9 2.33-1.2L12 11l7.67-5.7C20.64 4.6 22 5.3 22 6.5Z"/></svg>';

  function mailIcon() {
    const icon = document.createElement("img");
    icon.className = "mail-icon";
    icon.alt = "";
    icon.width = 24;
    icon.height = 24;
    icon.src = `data:image/svg+xml,${encodeURIComponent(MAIL_ICON)}`;
    return icon;
  }

  // Gmail shortcuts, a column of them in the top right corner, each wearing
  // the email it opens. The account list is the service worker's to find --
  // see modules/mail-accounts.js -- and the page only paints what is in
  // storage. Until something is there, or signed out of Google, that is one
  // plain Gmail button. Accounts the user hid stay off the page, and come back
  // dimmed with a Show switch while editing.
  function mailRow(account) {
    const hidden = Boolean(account) && settings.mail.isHidden(mailHidden, account.email);
    const row = document.createElement("div");
    row.className = "mail-row";
    if (hidden) row.classList.add("is-hidden");

    if (account && editing) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "mail-toggle";
      toggle.dataset.email = account.email.toLowerCase();
      toggle.textContent = hidden ? "Show" : "Hide";
      toggle.setAttribute("aria-pressed", String(hidden));
      toggle.setAttribute("aria-label", `${hidden ? "Show" : "Hide"} ${account.email} on the new tab`);
      toggle.addEventListener("click", () => void toggleMailAccount(account.email));
      row.append(toggle);
    }

    const label = settings.mail.label(account);
    const link = document.createElement("a");
    link.className = "mail-link";
    link.href = settings.mail.url(account?.email);
    link.title = account?.name ? `${account.name} \u2014 ${account.email}` : label;
    link.setAttribute("aria-label", label);
    if (account) {
      const email = document.createElement("span");
      email.className = "mail-email";
      email.textContent = account.email;
      link.append(email);
    }
    link.append(mailIcon());
    row.append(link);
    return row;
  }

  function renderMailAccounts() {
    const rows = mailAccounts.length
      ? mailAccounts
        .filter(account => editing || !settings.mail.isHidden(mailHidden, account.email))
        .map(mailRow)
      : [mailRow(null)];
    mailLinks.replaceChildren(...rows);
    mailLinks.hidden = rows.length === 0;
    // The chips centred above the search field stop short of the column, so
    // they never scroll underneath it in a narrow window, and the background
    // chooser stops below it, so it never covers an account when open.
    const box = mailLinks.hidden ? null : mailLinks.getBoundingClientRect?.();
    if (box?.width) {
      document.body.style.setProperty("--mail-room", `${Math.ceil(box.width) + 32}px`);
      document.body.style.setProperty("--mail-bottom", `${Math.ceil(box.bottom ?? box.top + box.height)}px`);
    } else {
      document.body.style.removeProperty("--mail-room");
      document.body.style.removeProperty("--mail-bottom");
    }
  }

  async function toggleMailAccount(email) {
    const hiding = !settings.mail.isHidden(mailHidden, email);
    mailHidden = settings.mail.toggleHidden(mailHidden, email);
    renderMailAccounts();
    // The switch was rebuilt under the pointer; keep the keyboard on it.
    const key = email.toLowerCase();
    [...(mailLinks.querySelectorAll?.(".mail-toggle") ?? [])].find(toggle => toggle.dataset.email === key)?.focus();
    try {
      await chrome.storage.local.set({ [settings.mail.hiddenKey]: mailHidden });
      setStatus(hiding ? `${email} hidden from the new tab.` : `${email} shown on the new tab.`);
    } catch {
      setStatus("Could not save which accounts are hidden.");
    }
  }

  // The worker owns the list and decides whether it is stale; the page only
  // says it is about to be looked at.
  function nudgeMailAccounts() {
    try {
      chrome.runtime.sendMessage?.({ type: settings.mail.refreshMessage })?.catch?.(() => {});
    } catch {
      // No worker to ask: what is in storage is what there is.
    }
  }

  function iconButton(symbol, title, onClick, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `icon-button ${className}`.trim();
    button.title = title;
    button.setAttribute("aria-label", title);
    button.textContent = symbol;
    button.addEventListener("click", onClick);
    return button;
  }

  function renderTile(group, bookmark, index) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.draggable = editing;
    tile.dataset.bookmarkId = bookmark.id;

    const link = document.createElement("a");
    link.href = bookmark.url;
    link.title = bookmark.url;
    link.draggable = false;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = bookmark.label;
    link.append(faviconElement(bookmark.url, bookmark.label), label);
    link.addEventListener("keydown", (event) => {
      if (!event.altKey) return;
      const here = groupIndex(group.id);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        moveBookmark({ groupId: group.id, bookmarkId: bookmark.id }, group.id, event.key === "ArrowLeft" ? index - 1 : index + 2);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const target = groups[event.key === "ArrowUp" ? here - 1 : here + 1];
        if (!target) return;
        event.preventDefault();
        moveBookmark({ groupId: group.id, bookmarkId: bookmark.id }, target.id, target.bookmarks.length);
      }
    });

    tile.addEventListener("dragstart", (event) => {
      dragged = { kind: "tile", groupId: group.id, bookmarkId: bookmark.id };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(TILE_TYPE, bookmark.id);
      event.dataTransfer.setData("text/plain", bookmark.url);
      tile.classList.add("dragging");
    });
    tile.addEventListener("dragend", () => {
      dragged = null;
      tile.classList.remove("dragging");
      clearDropHints();
    });
    tile.addEventListener("dragover", (event) => {
      if (dragged?.kind !== "tile") return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      markDrop(tile, dropSide(event, tile, "x"));
    });
    tile.addEventListener("drop", (event) => {
      if (dragged?.kind !== "tile") return;
      event.preventDefault();
      event.stopPropagation();
      const side = dropSide(event, tile, "x");
      clearDropHints();
      moveBookmark(dragged, group.id, side === "after" ? index + 1 : index);
      dragged = null;
    });

    tile.append(link);
    if (editing) {
      const actions = document.createElement("div");
      actions.className = "tile-actions";
      actions.append(
        iconButton("✎", `Edit ${bookmark.label}`, () => void editBookmark(group, bookmark)),
        iconButton("✕", `Remove ${bookmark.label}`, () => void removeBookmark(group, bookmark), "remove")
      );
      tile.append(actions);
    }
    return tile;
  }

  function renderGroup(group, position) {
    const card = document.createElement("article");
    card.className = "group";
    card.dataset.groupId = group.id;

    const header = document.createElement("div");
    header.className = "group-header";

    // The handle and the header buttons only exist while editing, so a plain
    // new tab is a board of shortcuts and nothing else.
    function dragHandle() {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "icon-button handle";
      handle.draggable = true;
      handle.textContent = "⠿";
      handle.title = `Move ${group.name}`;
      handle.setAttribute("aria-label", `Move ${group.name}. Use the arrow keys to reorder.`);
      handle.dataset.handleFor = group.id;
      handle.addEventListener("dragstart", (event) => {
        dragged = { kind: "group", groupId: group.id };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(GROUP_TYPE, group.id);
        event.dataTransfer.setDragImage?.(card, 24, 24);
        card.classList.add("dragging");
      });
      handle.addEventListener("dragend", () => {
        dragged = null;
        card.classList.remove("dragging");
        clearDropHints();
      });
      handle.addEventListener("keydown", (event) => {
        const moves = { ArrowLeft: position - 1, ArrowRight: position + 2, Home: 0, End: groups.length };
        if (!(event.key in moves)) return;
        event.preventDefault();
        moveGroup(group.id, moves[event.key]);
      });
      return handle;
    }

    const name = document.createElement("h2");
    name.className = "group-name";
    name.textContent = group.name;
    if (editing) header.append(dragHandle());
    header.append(name);
    if (editing) {
      header.append(
        iconButton("✎", `Rename ${group.name}`, () => void renameGroup(group)),
        iconButton("✕", `Delete ${group.name}`, () => void deleteGroup(group), "remove")
      );
    }

    const tiles = document.createElement("div");
    tiles.className = "tiles";
    tiles.append(...group.bookmarks.map((bookmark, index) => renderTile(group, bookmark, index)));

    function addTile() {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "add-tile";
      add.setAttribute("aria-label", `Add bookmark to ${group.name}`);
      const addIcon = document.createElement("span");
      addIcon.className = "favicon add-icon";
      addIcon.setAttribute("aria-hidden", "true");
      addIcon.textContent = "+";
      const addLabel = document.createElement("span");
      addLabel.className = "label";
      addLabel.textContent = "Add";
      add.append(addIcon, addLabel);
      add.addEventListener("click", () => void editBookmark(group, null));
      return add;
    }

    card.addEventListener("dragover", (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dragged.kind === "group") markDrop(card, dropSide(event, card, "x"));
      else {
        clearDropHints();
        card.classList.add("drop-into");
      }
    });
    card.addEventListener("dragleave", (event) => {
      if (event.target === card) card.classList.remove("drop-into");
    });
    card.addEventListener("drop", (event) => {
      if (!dragged) return;
      event.preventDefault();
      const side = dropSide(event, card, "x");
      clearDropHints();
      if (dragged.kind === "group") moveGroup(dragged.groupId, side === "after" ? position + 1 : position);
      else moveBookmark(dragged, group.id, group.bookmarks.length);
      dragged = null;
    });

    if (editing) tiles.append(addTile());
    card.append(header);
    if (!group.bookmarks.length) {
      const empty = document.createElement("p");
      empty.className = "group-empty";
      empty.textContent = editing
        ? "Empty — add one below, or drag a bookmark here."
        : "Empty — turn on editing to add a bookmark.";
      card.append(empty);
    }
    card.append(tiles);
    return card;
  }

  async function deleteGroup(group) {
    groups = groups.filter(entry => entry !== group);
    render();
    await saveGroups(`Group ${group.name} deleted.`);
  }

  async function removeBookmark(group, bookmark) {
    group.bookmarks = group.bookmarks.filter(entry => entry !== bookmark);
    render();
    await saveGroups(`${bookmark.label} removed.`);
  }

  function restoreFocus() {
    const target = focusAfterRender;
    focusAfterRender = null;
    if (!target) return;
    const selector = target.kind === "group"
      ? `[data-handle-for="${target.groupId}"]`
      : `[data-bookmark-id="${target.bookmarkId}"] a`;
    groupList.querySelector?.(selector)?.focus();
  }

  function render() {
    groupSizer?.disconnect();
    groupList.replaceChildren(...groups.map(renderGroup));
    if (groupSizer) {
      for (const card of groupList.children) {
        sizeGroup(card);
        groupSizer.observe(card);
      }
    }
    element("group-actions").hidden = !editing;
    // The hint explains dragging, which is only on offer while editing.
    element("drag-hint").hidden = !editing || groups.length < 2;
    restoreFocus();
  }

  /* Edit mode: one switch for every control that changes the board */

  function setEditing(on) {
    editing = on;
    document.body.classList.toggle("editing", editing);
    editToggle.setAttribute("aria-pressed", String(editing));
    const label = editing ? "Done editing" : "Edit shortcuts";
    editToggle.title = label;
    editToggle.setAttribute("aria-label", label);
    if (active) {
      render();
      renderMailAccounts();
    }
  }

  function onEditToggle() {
    setEditing(!editing);
    setStatus(editing ? "Editing on: rename, remove, add and drag, or hide a Gmail account." : "Editing off.");
  }

  // chrome:// pages are unreachable from a link or a location change, so the
  // shortcut has to navigate through the tabs API. Replacing this tab keeps an
  // empty new tab from being left behind; if that is refused, open a tab.
  async function onManageExtensions() {
    try {
      await chrome.tabs.update({ url: EXTENSIONS_URL });
    } catch {
      await chrome.tabs.create({ url: EXTENSIONS_URL });
    }
  }

  /* Wiring */

  function onAddGroup(event) {
    event.preventDefault();
    void addGroupNamed(newGroupName.value);
  }

  // Folders the page already shows are merged rather than duplicated, so this
  // is safe to press more than once.
  async function onImportBookmarks() {
    importBookmarks.disabled = true;
    let incoming = [];
    try {
      incoming = settings.bookmarkGroups(await chrome.bookmarks.getTree());
    } catch {
      setStatus("Could not read your Chrome bookmarks.");
    }
    if (!active) return;
    importBookmarks.disabled = false;
    const byName = new Map(groups.map(group => [group.name.toLocaleLowerCase(), group]));
    const known = new Set(groups.flatMap(group => group.bookmarks.map(bookmark => bookmark.url)));
    let added = 0;
    let newGroups = 0;
    for (const group of incoming) {
      const bookmarks = group.bookmarks.filter(bookmark => !known.has(bookmark.url));
      if (!bookmarks.length) continue;
      const existing = byName.get(group.name.toLocaleLowerCase());
      if (existing) {
        const room = settings.limits.bookmarks - existing.bookmarks.length;
        if (room <= 0) continue;
        existing.bookmarks.push(...bookmarks.slice(0, room));
        added += Math.min(room, bookmarks.length);
      } else {
        if (groups.length >= settings.limits.groups) break;
        groups.push({ ...group, bookmarks });
        byName.set(group.name.toLocaleLowerCase(), groups.at(-1));
        added += bookmarks.length;
        newGroups++;
      }
      for (const bookmark of bookmarks) known.add(bookmark.url);
    }
    if (!added) {
      setStatus("Your Chrome bookmarks are already here.");
      return;
    }
    render();
    await saveGroups(`Imported ${added} bookmark${added === 1 ? "" : "s"}${newGroups ? ` in ${newGroups} new group${newGroups === 1 ? "" : "s"}` : ""}.`);
  }

  function togglePanel(open = panel.hidden) {
    panel.hidden = !open;
    panelToggle.setAttribute("aria-expanded", String(open));
    if (open) void loadCollections();
  }

  function onPanelToggle() {
    togglePanel();
  }

  function onDocumentPointerDown(event) {
    if (!panel.hidden && !panel.contains(event.target) && !panelToggle.contains(event.target)) togglePanel(false);
    if (suggestions.length && !suggestionList.contains(event.target) && event.target !== query) closeSuggestions();
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && !panel.hidden) {
      togglePanel(false);
      panelToggle.focus();
      return;
    }
    if (event.key === "Escape" && editing) {
      setEditing(false);
      return;
    }
    if (event.key !== "/" || event.target === query) return;
    if (event.target.matches?.("input, textarea, [contenteditable]")) return;
    event.preventDefault();
    query.focus();
  }

  function onBookmarkSearchInput() {
    clearTimeout(bookmarkTimer);
    const text = bookmarkSearch.value;
    bookmarkTimer = setTimeout(() => void searchBookmarks(text, bookmarkContext), 120);
  }

  function onBookmarkSearchKeyDown(event) {
    if (event.key === "Escape" && bookmarkMatches.length) {
      event.preventDefault();
      event.stopPropagation();
      closeBookmarkSuggestions();
      return;
    }
    if (!bookmarkMatches.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlightMatch(activeMatch + 1 >= bookmarkMatches.length ? 0 : activeMatch + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlightMatch(activeMatch <= 0 ? bookmarkMatches.length - 1 : activeMatch - 1);
    } else if (event.key === "Enter") {
      // Enter here means "use this bookmark"; a second Enter then saves it.
      event.preventDefault();
      useMatch(bookmarkMatches[Math.max(activeMatch, 0)]);
    }
  }

  function onSchemeChange() {
    if (!active) return;
    applyBackground();
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (changes[settings.groupsKey]) {
      groups = settings.cleanGroups(changes[settings.groupsKey].newValue);
      render();
    }
    if (changes[settings.backgroundKey]) {
      background = settings.cleanBackground(changes[settings.backgroundKey].newValue);
      applyBackground();
    }
    // An account signed in or out, or hidden from another tab, shows up
    // without a reload.
    if (changes[settings.mail.key] || changes[settings.mail.hiddenKey]) {
      if (changes[settings.mail.key]) mailAccounts = settings.mail.clean(changes[settings.mail.key].newValue?.accounts);
      if (changes[settings.mail.hiddenKey]) mailHidden = settings.mail.cleanHidden(changes[settings.mail.hiddenKey].newValue);
      renderMailAccounts();
    }
  }

  function onImageChange(event) {
    const [file] = event.target.files;
    event.target.value = "";
    void useImageFile(file);
  }

  function onReset() {
    setMessage(panelMessage, "");
    void chooseBackground(settings.defaultBackground, "Background reset.");
  }

  function onWallpaperBack() {
    setMessage(panelMessage, "");
    showCollections();
  }

  function onGroupListDragOver(event) {
    if (dragged?.kind !== "group") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function onGroupListDrop(event) {
    if (dragged?.kind !== "group") return;
    event.preventDefault();
    clearDropHints();
    moveGroup(dragged.groupId, groups.length);
    dragged = null;
  }

  // First run borrows what the browser already knows: the bookmarks bar
  // first, then Chrome's own New Tab tiles, and only then a starter set.
  async function startingGroups() {
    if (chrome.bookmarks?.getTree) {
      try {
        const imported = settings.bookmarkGroups(await chrome.bookmarks.getTree());
        if (imported.length) return imported;
      } catch {
        // No bookmarks available; fall through to the next source.
      }
    }
    if (chrome.topSites?.get) {
      try {
        const group = settings.topSitesGroup(await chrome.topSites.get());
        if (group) return [group];
      } catch {
        // Same again.
      }
    }
    return settings.defaultGroups;
  }

  async function load() {
    let stored = {};
    try {
      stored = await chrome.storage.local.get([settings.groupsKey, settings.backgroundKey, settings.mail.key, settings.mail.hiddenKey]);
    } catch {
      setStatus("Could not read your saved bookmarks.");
    }
    if (!active) return;
    const saved = stored[settings.groupsKey];
    groups = saved === undefined ? await startingGroups() : settings.cleanGroups(saved);
    if (!active) return;
    background = settings.cleanBackground(stored[settings.backgroundKey]);
    applyBackground();
    mailAccounts = settings.mail.clean(stored[settings.mail.key]?.accounts);
    mailHidden = settings.mail.cleanHidden(stored[settings.mail.hiddenKey]);
    renderMailAccounts();
    render();
    if (saved === undefined) await saveGroups("");
  }

  renderMailAccounts();
  nudgeMailAccounts();
  buildSwatches(colorSwatches, settings.colors, "color");
  buildSwatches(gradientSwatches, settings.gradients, "gradient");
  applyBackground();
  // The stylesheet follows `prefers-color-scheme` on its own; the background
  // is painted from script, so it has to be told.
  lightQuery?.addEventListener?.("change", onSchemeChange);
  setEditing(false);
  form.addEventListener("submit", onSubmit);
  query.addEventListener("input", onQueryInput);
  query.addEventListener("keydown", onQueryKeyDown);
  newGroupForm.addEventListener("submit", onAddGroup);
  importBookmarks.hidden = !chrome.bookmarks?.getTree;
  importBookmarks.addEventListener("click", onImportBookmarks);
  for (const name of ["onCreated", "onUpdated", "onMoved", "onRemoved"]) {
    watchTabGroups(chrome.tabGroups?.[name]);
  }
  for (const name of ["onCreated", "onUpdated", "onMoved", "onRemoved", "onAttached", "onDetached"]) {
    watchTabGroups(chrome.tabs?.[name]);
  }
  groupList.addEventListener("dragover", onGroupListDragOver);
  groupList.addEventListener("drop", onGroupListDrop);
  editToggle.addEventListener("click", onEditToggle);
  // Without the tabs API there is no way to reach chrome://extensions.
  extensionsToggle.hidden = !chrome.tabs?.update;
  extensionsToggle.addEventListener("click", onManageExtensions);
  panelToggle.addEventListener("click", onPanelToggle);
  wallpaperBack.addEventListener("click", onWallpaperBack);
  imageInput.addEventListener("change", onImageChange);
  resetBackground.addEventListener("click", onReset);
  groupCancel.addEventListener("click", onGroupCancel);
  bookmarkCancel.addEventListener("click", onBookmarkCancel);
  bookmarkSearch.addEventListener("input", onBookmarkSearchInput);
  bookmarkSearch.addEventListener("keydown", onBookmarkSearchKeyDown);
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onKeyDown);
  chrome.storage.onChanged.addListener(onStorageChanged);
  app.hidden = false;
  void refreshTabGroups();
  // Chrome keeps the omnibox focused when a new tab opens; only take focus
  // when the page already has it, so typing there is never hijacked.
  if (document.hasFocus()) query.focus();
  void load();

  return () => {
    active = false;
    tabGroupRevision++;
    for (const unwatch of tabGroupWatchers) unwatch();
    tabGroupList.replaceChildren();
    tabGroupList.hidden = true;
    groupSizer?.disconnect();
    groupList.classList.remove("masonry");
    clearTimeout(statusTimer);
    clearTimeout(suggestTimer);
    clearTimeout(bookmarkTimer);
    suggestRequest?.abort();
    form.removeEventListener("submit", onSubmit);
    query.removeEventListener("input", onQueryInput);
    query.removeEventListener("keydown", onQueryKeyDown);
    newGroupForm.removeEventListener("submit", onAddGroup);
    newGroupName.value = "";
    importBookmarks.removeEventListener("click", onImportBookmarks);
    groupList.removeEventListener("dragover", onGroupListDragOver);
    groupList.removeEventListener("drop", onGroupListDrop);
    editToggle.removeEventListener("click", onEditToggle);
    extensionsToggle.removeEventListener("click", onManageExtensions);
    extensionsToggle.hidden = true;
    mailLinks.replaceChildren();
    mailLinks.hidden = true;
    document.body.style.removeProperty("--mail-room");
    document.body.style.removeProperty("--mail-bottom");
    panelToggle.removeEventListener("click", onPanelToggle);
    wallpaperBack.removeEventListener("click", onWallpaperBack);
    imageInput.removeEventListener("change", onImageChange);
    resetBackground.removeEventListener("click", onReset);
    groupCancel.removeEventListener("click", onGroupCancel);
    bookmarkCancel.removeEventListener("click", onBookmarkCancel);
    bookmarkSearch.removeEventListener("input", onBookmarkSearchInput);
    bookmarkSearch.removeEventListener("keydown", onBookmarkSearchKeyDown);
    document.removeEventListener("pointerdown", onDocumentPointerDown);
    document.removeEventListener("keydown", onKeyDown);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    lightQuery?.removeEventListener?.("change", onSchemeChange);
    groupDialog.close();
    bookmarkDialog.close();
    togglePanel(false);
    closeSuggestions();
    closeBookmarkSuggestions();
    collectionList.replaceChildren();
    wallpaperList.replaceChildren();
    colorSwatches.replaceChildren();
    gradientSwatches.replaceChildren();
    groupList.replaceChildren();
    setMessage(panelMessage, "");
    attribution.hidden = true;
    attribution.replaceChildren();
    status.textContent = "";
    app.hidden = true;
    setEditing(false);
    document.body.classList.remove("has-image");
    document.body.style.backgroundColor = "";
    document.body.style.backgroundImage = "";
  };
});
