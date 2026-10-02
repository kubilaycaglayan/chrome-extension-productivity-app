productivityModules.register("mackolik-featured-video", () => {
  const removed = [];
  const highlightAttribute = "data-productivity-team-highlight";
  const priorityRows = createMackolikPriorityRows(highlightAttribute);
  let active = true;
  let pageReady = false;
  let startupTimer = null;
  let settingsRevision = 0;
  let refreshQueued = false;
  let refreshFrame = null;
  let sortingDeferred = false;
  let highlightedTeams = mackolikSettings.defaults.map(name => mackolikSettings.normalize(name));
  let followedTeams = [];
  let broadcastRequest = null;
  let broadcastKey = null;
  let broadcastData = null;
  let broadcastError = false;
  let broadcastFetchedAt = 0;
  const broadcastCells = new Map();
  const title = document.createElement("h1");
  title.id = "productivity-mackolik-title";
  title.textContent = "Canlı Sonuçlar";
  const heading = document.createElement("div");
  heading.id = "productivity-mackolik-heading";
  heading.appendChild(title);
  const galaday = document.createElement("strong");
  galaday.id = "productivity-mackolik-galaday";
  galaday.setAttribute("aria-label", "Galaday");
  const redShades = ["#ff8ba7", "#ff967e", "#ff896a"];
  const goldShades = ["#ffe66d", "#ffcb70", "#ffda7a", "#ffc061"];
  const startsRed = Math.random() < 0.5;
  for (const [index, letter] of [..."Galaday"].entries()) {
    const span = document.createElement("span");
    span.textContent = letter;
    span.setAttribute("aria-hidden", "true");
    const shades = (index % 2 === 0) === startsRed ? redShades : goldShades;
    const shade = shades[Math.floor(Math.random() * shades.length)];
    span.style.setProperty("--galaday-color", shade);
    if (index === 0) galaday.style.setProperty("--galaday-glow", shade);
    galaday.appendChild(span);
  }
  galaday.hidden = true;
  const movedControls = [];
  const controlCleanups = [];
  const style = document.createElement("style");
  const removalSelector = [
    ".cookie-consent-rectangle-wrapper",
    "#live-top-menu",
    "#menu",
    "#wrapper",
    // Match numbered banner placeholder classes, even alongside other classes.
    '[class^="bannerPlaceHolder"]',
    '[class*=" bannerPlaceHolder"]',
    '[data-type="_mgwidget"]',
    '.eyeo[data-widget-id]',
    "#dvTutturStickyBanner",
    "#dvExtraBanner",
    "#canli_google_div"
  ].join(", ");
  // writeBanner() accesses these containers synchronously after rendering new
  // placeholders. Removing them throws and triggers the site's 1-second retry.
  const hiddenBannerSelector = '[id^="bannerContainer"], #live-score-righttemp';
  style.textContent = `
    ${removalSelector}, ${hiddenBannerSelector} { display: none !important; }

    /* Override the site's small fixed font sizes, including live updates. */
    body, body * {
      font-size: 16px !important;
    }

    #body,
    #live-score-rightcoll {
      width: 100% !important;
      max-width: 980px !important;
    }

    #live-score-lefttemp {
      float: none !important;
      width: 734px !important;
      max-width: 100% !important;
      margin-inline: auto !important;
    }

    #productivity-mackolik-heading {
      display: flex !important;
      align-items: center !important;
      flex-wrap: wrap !important;
      gap: 12px 20px !important;
      margin: 0 0 12px !important;
      padding: 8px 0 0 !important;
      width: 100% !important;
      box-sizing: border-box !important;
    }

    #productivity-mackolik-title {
      margin: 0 !important;
      padding: 0 !important;
      font-size: 24px !important;
      font-weight: 700 !important;
      line-height: 1.3 !important;
      color: #fff !important;
      text-align: left !important;
    }

    #productivity-mackolik-galaday {
      display: inline-flex !important;
      align-items: center !important;
      margin-left: auto !important;
      padding: 4px !important;
      border-radius: 6px !important;
      background: #071b26 !important;
      box-shadow: 0 0 8px var(--galaday-glow);
      animation: productivity-galaday-frame-glow 1.5s ease-in-out 5 !important;
      font-size: 28.8px !important;
      font-weight: 800 !important;
      line-height: 1.3 !important;
      letter-spacing: 0.02em;
      white-space: nowrap !important;
    }
    #productivity-mackolik-galaday span {
      color: var(--galaday-color) !important;
      font-size: 28.8px !important;
      font-weight: 800 !important;
      text-shadow: 0 0 8px var(--galaday-color), 0 0 14px var(--galaday-color);
      animation: productivity-galaday-letter-glow 1.5s ease-in-out 5 !important;
    }
    @keyframes productivity-galaday-frame-glow {
      0%, 100% { box-shadow: 0 0 8px var(--galaday-glow); }
      50% { box-shadow: 0 0 18px 6px var(--galaday-glow), inset 0 0 12px var(--galaday-glow); }
    }
    @keyframes productivity-galaday-letter-glow {
      0%, 100% { text-shadow: 0 0 8px var(--galaday-color), 0 0 14px var(--galaday-color); }
      50% { text-shadow: 0 0 10px var(--galaday-color), 0 0 22px var(--galaday-color), 0 0 32px var(--galaday-color); }
    }
    #productivity-mackolik-galaday[hidden] {
      display: none !important;
    }

    #productivity-mackolik-heading .select-temp {
      display: flex !important;
      align-items: center !important;
      float: none !important;
      width: auto !important;
      height: auto !important;
      gap: 4px !important;
      padding: 4px !important;
      margin: 0 !important;
      background: #071b26 !important;
      border: 1px solid #36f9c5 !important;
      border-radius: 12px !important;
      box-shadow: 0 2px 8px #071b2633;
    }

    #productivity-mackolik-heading .select-bg {
      float: none !important;
      width: auto !important;
      height: auto !important;
      padding: 0 !important;
      margin: 0 !important;
      background: none !important;
    }

    #productivity-mackolik-heading .select-temp .textbox {
      width: 132px !important;
      height: 36px !important;
      line-height: 36px !important;
      padding: 0 8px !important;
      margin: 0 !important;
      border: 0 !important;
      border-radius: 6px !important;
      box-sizing: border-box !important;
      float: none !important;
      color: #f4fbff !important;
      background: #102d3a !important;
      font-weight: 600 !important;
      font-variant-numeric: tabular-nums;
      text-align: center !important;
    }

    #productivity-mackolik-heading .date-left-coll,
    #productivity-mackolik-heading .date-right-coll {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      flex: 0 0 36px !important;
      width: 36px !important;
      height: 36px !important;
      margin: 0 !important;
      padding: 0 !important;
      float: none !important;
      background: none !important;
      border-radius: 7px !important;
      color: #36f9c5 !important;
      cursor: pointer !important;
    }
    #productivity-mackolik-heading .date-left-coll::before,
    #productivity-mackolik-heading .date-right-coll::before {
      content: "";
      width: 8px;
      height: 8px;
      border-top: 2px solid currentColor;
      border-right: 2px solid currentColor;
    }
    #productivity-mackolik-heading .date-left-coll::before { transform: rotate(-135deg); }
    #productivity-mackolik-heading .date-right-coll::before { transform: rotate(45deg); }
    #productivity-mackolik-heading .date-left-coll:hover,
    #productivity-mackolik-heading .date-right-coll:hover {
      background: #102d3a !important;
    }
    #productivity-mackolik-heading .date-left-coll:focus-visible,
    #productivity-mackolik-heading .date-right-coll:focus-visible,
    #productivity-mackolik-heading .textbox:focus-visible {
      outline: 2px solid #36f9c5 !important;
      outline-offset: 1px !important;
    }
    #productivity-mackolik-heading .select-rightcoll {
      display: none !important;
    }

    /* Match and league rows need room for the larger text. */
    #dvScores .list-table tr {
      height: 32px !important;
    }

    #dvScores .list-table td {
      height: 24px !important;
      line-height: 24px !important;
      padding-top: 4px !important;
      padding-bottom: 4px !important;
      vertical-align: middle !important;
    }

    #dvScores .list-table tr.rows-bg > td[align="center"] > b {
      display: none !important;
    }

    /* The site's 12px team-name boxes clip text even inside taller rows. */
    #dvScores .teamDiv {
      height: auto !important;
      min-height: 24px !important;
      line-height: 24px !important;
      overflow: visible !important;
      white-space: normal !important;
      overflow-wrap: anywhere;
    }

    #dvScores .list-table tr.row > td.productivity-broadcast {
      padding-inline: 8px !important;
      line-height: 1.3 !important;
      white-space: normal !important;
      overflow-wrap: anywhere;
    }

    /* Neon accents surround solid, high-contrast text; no text glow. */
    #dvScores .list-table tr[${highlightAttribute}] > td {
      background: #071b26 !important;
      color: #f4fbff !important;
      border-top: 1px solid #36f9c5 !important;
      border-bottom: 1px solid #36f9c5 !important;
    }
    #dvScores .list-table tr[${highlightAttribute}] > td * {
      color: #f4fbff !important;
      background-color: transparent !important;
      background-image: none !important;
      text-shadow: none !important;
    }
    #dvScores .list-table tr[${highlightAttribute}] > td:first-child {
      padding-left: 10px !important;
      box-shadow: inset 4px 0 #36f9c5;
    }
    #dvScores .list-table tr[${highlightAttribute}] > td:last-child {
      box-shadow: inset -2px 0 #36f9c5;
    }
    #dvScores .list-table tr[${highlightAttribute}] .teamDiv a,
    #dvScores .list-table tr[${highlightAttribute}] .td_score {
      color: #36f9c5 !important;
      font-weight: 700 !important;
    }
    #dvScores .list-table tr[${highlightAttribute}] .red_score,
    #dvScores .list-table tr[${highlightAttribute}] .red_score *,
    #dvScores .list-table tr[${highlightAttribute}] .td_red1,
    #dvScores .list-table tr[${highlightAttribute}] .td_red2 {
      color: #ffb4ce !important;
      font-weight: 700 !important;
    }
    #dvScores .list-table tr[${highlightAttribute}]:hover > td {
      background: #102d3a !important;
    }
    #dvScores .list-table tr[${highlightAttribute}] a:focus-visible {
      outline: 2px solid #36f9c5 !important;
      outline-offset: 2px;
    }
    #dvScores .list-table tr[${highlightAttribute}="followed"] > td {
      background: #261b07 !important;
      border-color: #ffe082 !important;
    }
    #dvScores .list-table tr[${highlightAttribute}="followed"] > td:first-child {
      box-shadow: inset 4px 0 #ffe082;
    }
    #dvScores .list-table tr[${highlightAttribute}="followed"] > td:last-child {
      box-shadow: inset -2px 0 #ffe082;
    }
    #dvScores .list-table tr[${highlightAttribute}="followed"] .teamDiv a,
    #dvScores .list-table tr[${highlightAttribute}="followed"] .td_score {
      color: #ffe082 !important;
    }
    #dvScores .list-table tr[${highlightAttribute}="followed"]:hover > td {
      background: #3a2c10 !important;
    }
    #dvScores .list-table tr[${highlightAttribute}="followed"] a:focus-visible {
      outline-color: #ffe082 !important;
    }
    #dvScores .productivity-team-group td {
      background: #071b26 !important;
      color: #36f9c5 !important;
      font-weight: 700 !important;
      padding-left: 12px !important;
    }
    #dvScores .productivity-team-group[data-group="followed"] td {
      background: #261b07 !important;
      color: #ffe082 !important;
    }
    #dvScores .list-table tr.productivity-group-gap,
    #dvScores .list-table tr.productivity-group-gap > td {
      height: 24px !important;
      line-height: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      background: transparent !important;
    }
    #dvScores .list-table tr.productivity-list-gap,
    #dvScores .list-table tr.productivity-list-gap > td {
      height: 36px !important;
      line-height: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      background: #3866b0 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  function removeContainer(container) {
    // Let the parser finish building the date control before detaching its parent.
    if (container.id === "live-top-menu" && document.readyState === "loading") return;
    const placeholder = document.createComment("productivity-mackolik-removed");
    container.before(placeholder);
    removed.push({ container, placeholder });
    container.remove();
  }

  function removeVideoContainer() {
    const video = document.getElementById("featured-video");
    // iframe → figure → inner div → outer div.
    const container = video?.parentElement?.parentElement?.parentElement;
    if (!container || container.tagName !== "DIV" || !container.parentNode) return;
    removeContainer(container);
  }
  function removeUnwantedElements() {
    if (!active || !pageReady) return;
    // Keep the heading outside dvScores, whose contents live updates replace.
    const scores = document.getElementById("dvScores");
    if (scores && scores.previousElementSibling !== heading) scores.before(heading);
    if (scores) {
      for (const control of document.querySelectorAll(".select-temp")) {
        if (heading.contains(control) || !control.closest(removalSelector)) continue;
        const placeholder = document.createComment("productivity-mackolik-date-control");
        control.before(placeholder);
        movedControls.push({ control, placeholder });
        // Move the existing node so its value and event handlers survive.
        heading.appendChild(control);
        for (const [selector, label] of [[".date-left-coll", "Önceki gün"], [".date-right-coll", "Sonraki gün"]]) {
          const button = control.querySelector(selector);
          if (!button) continue;
          const attributes = ["role", "tabindex", "aria-label", "title"];
          const original = attributes.map(name => button.getAttribute(name));
          button.setAttribute("role", "button");
          button.setAttribute("tabindex", "0");
          button.setAttribute("aria-label", label);
          button.setAttribute("title", label);
          const onKeydown = event => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              button.click();
            }
          };
          button.addEventListener("keydown", onKeydown);
          controlCleanups.push(() => {
            button.removeEventListener("keydown", onKeydown);
            attributes.forEach((name, index) => {
              if (original[index] === null) button.removeAttribute(name);
              else button.setAttribute(name, original[index]);
            });
          });
        }
      }
    }
    removeVideoContainer();
    document.querySelectorAll(removalSelector).forEach(removeContainer);
    highlightRows();
  }

  function highlightRows() {
    let hasGalatasarayGame = false;
    for (const row of document.querySelectorAll("#dvScores .list-table tr.row")) {
      const names = [...row.querySelectorAll(".teamDiv")].map(team =>
        mackolikSettings.normalize(team.querySelector?.("a")?.textContent || team.textContent));
      if (row.getAttribute("sport") === "1" && names.includes("galatasaray")) hasGalatasarayGame = true;
      const matches = highlightedTeams.some(name => names.includes(name));
      const follows = followedTeams.some(name => names.includes(name));
      const group = matches ? "main" : follows ? "followed" : null;
      if (group && row.getAttribute(highlightAttribute) !== group) row.setAttribute(highlightAttribute, group);
      else if (!group && row.hasAttribute(highlightAttribute)) row.removeAttribute(highlightAttribute);
    }
    galaday.hidden = !hasGalatasarayGame;
    if (hasGalatasarayGame && heading.lastElementChild !== galaday) heading.appendChild(galaday);
    updateBroadcasts();
    const selection = document.getSelection?.();
    const selectedNode = selection?.anchorNode;
    const selectedElement = selectedNode?.nodeType === 1 ? selectedNode : selectedNode?.parentElement;
    if (selection && !selection.isCollapsed && selectedElement?.closest("#dvScores")) {
      sortingDeferred = true;
    } else {
      sortingDeferred = false;
      priorityRows.refresh();
    }
  }

  function broadcastSourceKey() {
    const date = document.getElementById("txtCalendar")?.value?.trim();
    return /^\d{2}\/\d{2}\/\d{4}$/.test(date || "") ? `date=${encodeURIComponent(date)}` : "group=0";
  }

  function updateBroadcasts() {
    const rows = [...document.querySelectorAll(`#dvScores .list-table tr.row[${highlightAttribute}]`)]
      .filter(row => /^row_\d+$/.test(row.id || ""));
    for (const row of broadcastCells.keys()) if (!rows.includes(row)) restoreBroadcastCells(row);
    if (!rows.length) {
      broadcastRequest?.abort();
      broadcastRequest = null;
      broadcastKey = null;
      broadcastData = null;
      return;
    }

    const key = broadcastSourceKey();
    if (broadcastKey !== key || Date.now() - broadcastFetchedAt > 5 * 60 * 1000) {
      broadcastRequest?.abort();
      broadcastKey = key;
      broadcastData = null;
      broadcastError = false;
      broadcastFetchedAt = Date.now();
      const request = new AbortController();
      broadcastRequest = request;
      fetch(`https://arsiv.mackolik.com/livescores/tvprogram.aspx?${key}`, { signal: request.signal })
        .then(response => {
          if (!response.ok) throw new Error(`TV program: ${response.status}`);
          return response.json();
        })
        .then(data => {
          if (!active || broadcastRequest !== request) return;
          broadcastData = data;
          broadcastRequest = null;
          updateBroadcasts();
        })
        .catch(() => {
          if (broadcastRequest !== request) return;
          broadcastRequest = null;
          broadcastError = true;
          updateBroadcasts();
        });
    }
    updateBroadcastCells(rows);
  }

  function restoreBroadcastCells(row) {
    const state = broadcastCells.get(row);
    if (!state) return;
    for (const original of state.originals) row.insertBefore(original, state.cell.parentElement === row ? state.cell : null);
    state.cell.remove();
    broadcastCells.delete(row);
  }

  function updateBroadcastCells(rows) {
    for (const row of rows) {
      const id = row.id.slice(4);
      const channels = Array.isArray(broadcastData?.[id])
        ? [...new Set(broadcastData[id].map(entry => typeof entry?.[0] === "string" ? entry[0].trim() : "").filter(Boolean))]
        : [];
      let state = broadcastCells.get(row);
      if (!state) {
        const first = row.querySelector("td.td_HTScore");
        if (!first) continue;
        const originals = [first];
        for (let index = 0; index < 3; index++) {
          const next = originals[originals.length - 1].nextElementSibling;
          if (!next || next.tagName !== "TD") break;
          originals.push(next);
        }
        if (originals.length !== 4) continue;
        const cell = document.createElement("td");
        cell.className = "productivity-broadcast";
        cell.colSpan = 4;
        row.insertBefore(cell, first);
        originals.forEach(original => original.remove());
        state = { cell, originals };
        broadcastCells.set(row, state);
      }
      const { cell } = state;
      cell.textContent = channels.join(", ");
      cell.setAttribute("aria-label", `TV yayını: ${channels.length ? channels.join(", ") : broadcastError ? "Bilgi alınamadı" : broadcastData ? "Bilgi yok" : "Yükleniyor"}`);
    }
  }

  function applyTeams(value, followed = false) {
    const teams = (Array.isArray(value) ? mackolikSettings.clean(value) : followed ? [] : mackolikSettings.defaults)
      .map(name => mackolikSettings.normalize(name));
    if (followed) followedTeams = teams;
    else highlightedTeams = teams;
  }
  function onSettingsChanged(changes, area) {
    if (area !== "local" || (!changes[mackolikSettings.key] && !changes[mackolikSettings.followedKey])) return;
    settingsRevision++;
    if (changes[mackolikSettings.key]) applyTeams(changes[mackolikSettings.key].newValue);
    if (changes[mackolikSettings.followedKey]) applyTeams(changes[mackolikSettings.followedKey].newValue, true);
    runRefresh();
  }
  chrome.storage.onChanged.addListener(onSettingsChanged);
  const initialRevision = settingsRevision;
  chrome.storage.local.get([mackolikSettings.key, mackolikSettings.followedKey]).then(result => {
    if (active && settingsRevision === initialRevision) {
      applyTeams(result[mackolikSettings.key]);
      applyTeams(result[mackolikSettings.followedKey], true);
      runRefresh();
    }
  }).catch(() => {});
  const observation = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "id", "sport"]
  };
  function runRefresh() {
    if (!active) return;
    // Our own moves must not trigger another observer pass.
    observer.disconnect();
    try {
      removeUnwantedElements();
    } finally {
      if (active) observer.observe(document.documentElement, observation);
    }
  }
  function queueRefresh() {
    if (!active || refreshQueued) return;
    refreshQueued = true;
    refreshFrame = requestAnimationFrame(() => {
      refreshQueued = false;
      refreshFrame = null;
      runRefresh();
    });
  }
  const relevantSelector = `${removalSelector}, #featured-video, #dvScores, .list-table, tr.row, .select-temp, .teamDiv`;
  function needsRefresh(records) {
    return records.some(record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (record.type === "characterData") return Boolean(target?.closest(".teamDiv"));
      if (record.type === "attributes") {
        if (record.attributeName === "sport") return Boolean(target?.matches("tr.row"));
        // Score status and hover classes change frequently and do not affect grouping.
        return Boolean(target?.matches(`${removalSelector}, #featured-video, .select-temp, .teamDiv`));
      }
      if (target?.closest(".teamDiv")) return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
        (node.matches(relevantSelector) || node.querySelector(relevantSelector)));
    });
  }
  const observer = new MutationObserver(records => {
    if (needsRefresh(records)) queueRefresh();
  });
  const onSelectionChanged = () => {
    if (sortingDeferred && document.getSelection()?.isCollapsed) queueRefresh();
  };
  function scheduleStartup() {
    if (!active || pageReady || startupTimer !== null) return;
    // jQuery 1.8 aborts its remaining ready callbacks if the video initializer
    // cannot find #featured-media. Wait until the entire DOMContentLoaded task
    // has finished before moving/removing any of the site's startup elements.
    startupTimer = setTimeout(() => {
      startupTimer = null;
      if (!active) return;
      pageReady = true;
      runRefresh();
    }, 0);
  }
  observer.observe(document.documentElement, observation);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleStartup, { once: true });
  } else {
    scheduleStartup();
  }
  document.addEventListener("selectionchange", onSelectionChanged);
  return () => {
    active = false;
    broadcastRequest?.abort();
    if (startupTimer !== null) clearTimeout(startupTimer);
    observer.disconnect();
    if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
    priorityRows.cleanup();
    chrome.storage.onChanged.removeListener(onSettingsChanged);
    document.querySelectorAll(`[${highlightAttribute}]`).forEach(row => row.removeAttribute(highlightAttribute));
    for (const row of broadcastCells.keys()) restoreBroadcastCells(row);
    document.removeEventListener("DOMContentLoaded", scheduleStartup);
    document.removeEventListener("selectionchange", onSelectionChanged);
    controlCleanups.forEach(cleanup => cleanup());
    for (const { control, placeholder } of movedControls) placeholder.replaceWith(control);
    heading.remove();
    style.remove();
    for (const { container, placeholder } of removed) {
      placeholder.replaceWith(container);
    }
  };
});
