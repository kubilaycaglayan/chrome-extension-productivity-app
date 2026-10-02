const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function element(tagName = "DIV") {
  const attributes = new Map();
  return {
    tagName,
    style: { setProperty() {} },
    children: [],
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    insertBefore(child, reference) {
      child.remove();
      child.parentElement = this;
      const index = reference ? this.children.indexOf(reference) : -1;
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      return child;
    },
    get nextElementSibling() {
      if (!this.parentElement) return null;
      return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null;
    },
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    },
    setAttribute(key, value) { attributes.set(key, value); },
    getAttribute(key) { return attributes.get(key) ?? null; },
    hasAttribute(key) { return attributes.has(key); },
    removeAttribute(key) { attributes.delete(key); }
  };
}

function match(id, team) {
  const row = element("TR");
  row.id = `row_${id}`;
  row.setAttribute("sport", "1");
  for (let index = 0; index < 4; index++) {
    const cell = element("TD");
    if (index === 0) cell.className = "td_HTScore";
    row.appendChild(cell);
  }
  row.querySelectorAll = selector => selector === ".teamDiv" ? [{ textContent: team }] : [];
  row.querySelector = selector => selector === "td.productivity-broadcast"
    ? row.children.find(child => child.className === "productivity-broadcast") || null
    : selector === "td.td_HTScore" ? row.children.find(child => child.className === "td_HTScore") || null : null;
  return row;
}

async function run() {
  const highlight = "data-productivity-team-highlight";
  const rows = [match(4444922, "Türkiye"), match(4542698, "Galatasaray"), match(4547826, "Arsenal"), match(7, "Chelsea")];
  const listeners = new Set();
  const requests = [];
  const calendar = { value: "02/10/2026" };
  let cleanup;
  const context = vm.createContext({
    productivityModules: { register(id, start) { cleanup = start(); } },
    createMackolikPriorityRows: () => ({ refresh() {}, cleanup() {} }),
    chrome: { storage: {
      local: { get: async () => ({ mackolikHighlightedTeams: ["Türkiye", "Galatasaray"], mackolikFollowedTeams: ["Arsenal"] }) },
      onChanged: { addListener(listener) { listeners.add(listener); }, removeListener(listener) { listeners.delete(listener); } }
    } },
    document: {
      readyState: "complete",
      documentElement: { appendChild() {} },
      createElement: element,
      getElementById: id => id === "txtCalendar" ? calendar : null,
      querySelectorAll(selector) {
        if (selector === "#dvScores .list-table tr.row") return rows;
        if (selector === `#dvScores .list-table tr.row[${highlight}]`) return rows.filter(row => row.hasAttribute(highlight));
        if (selector === "#dvScores td.productivity-broadcast") return rows.flatMap(row => row.children.filter(child => child.className === "productivity-broadcast"));
        if (selector === `[${highlight}]`) return rows.filter(row => row.hasAttribute(highlight));
        return [];
      },
      addEventListener() {}, removeEventListener() {}
    },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController,
    fetch(url, options) {
      return new Promise(resolve => requests.push({ url, signal: options.signal, resolve }));
    },
    setTimeout(fn) { fn(); return 1; }, clearTimeout() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}
  });
  vm.runInContext(fs.readFileSync("shared/mackolik-settings.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("content/mackolik-featured-video.js", "utf8"), context);
  await Promise.resolve();
  assert.equal(requests.length, 1, "One TV-program request serves all followed matches");
  assert.match(requests[0].url, /date=02%2F10%2F2026$/);
  requests[0].resolve({ ok: true, json: async () => ({
    "4444922": [["ATV", "1"]],
    "4542698": [["beIN SPORTS 1", "1"]],
    "4547826": [["S Sport 2", ""], ["S Sport Plus", ""]]
  }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows[0].querySelector("td.productivity-broadcast").textContent, "ATV");
  assert.equal(rows[0].querySelector("td.productivity-broadcast").colSpan, 4);
  assert.equal(rows[0].children.length, 1, "TV listing replaces four existing cells");
  assert.equal(rows[1].querySelector("td.productivity-broadcast").textContent, "beIN SPORTS 1");
  assert.equal(rows[2].querySelector("td.productivity-broadcast").textContent, "S Sport 2, S Sport Plus");
  assert.equal(rows[3].querySelector("td.productivity-broadcast"), null);

  calendar.value = "03/10/2026";
  for (const listener of listeners) listener({ mackolikFollowedTeams: { newValue: ["Arsenal"] } }, "local");
  assert.equal(requests.length, 2, "Changing date loads its own listings");
  requests[1].resolve({ ok: true, json: async () => ({ "4444922": [["TRT 1", "1"]] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows[0].querySelector("td.productivity-broadcast").textContent, "TRT 1");
  assert.equal(rows[1].querySelector("td.productivity-broadcast").textContent, "");

  for (const listener of listeners) listener({ mackolikFollowedTeams: { newValue: [] } }, "local");
  assert.equal(rows[2].querySelector("td.productivity-broadcast"), null, "Removed follows lose the channel cell");
  assert.equal(rows[2].children.length, 4, "Removed follows regain their original cells");
  cleanup();
  assert.equal(rows[0].querySelector("td.productivity-broadcast"), null, "Disable removes inserted cells");
  assert.equal(rows[0].children.length, 4, "Disable restores the match cells");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
