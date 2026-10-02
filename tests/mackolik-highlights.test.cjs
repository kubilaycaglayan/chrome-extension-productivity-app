const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function row(...names) {
  const attributes = new Map();
  return {
    names,
    querySelectorAll: () => names.map(textContent => ({ textContent })),
    hasAttribute: name => attributes.has(name),
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute: name => attributes.delete(name)
  };
}

async function run() {
  const attribute = "data-productivity-team-highlight";
  const rows = [row("Real Madrid", "Valencia"), row("TÜRKİYE", "Belçika"), row("Galatasaray", "Fenerbahçe"), row("BESIKTAS", "Barcelona"), row("Arsenal", "Chelsea")];
  const listeners = new Set();
  let cleanup, observerCallback, observation, resolveInitial;
  const style = { remove() {} };
  const context = vm.createContext({
    productivityModules: { register(id, start) { cleanup = start(); } },
    chrome: { storage: {
      local: { get: () => new Promise(resolve => { resolveInitial = resolve; }) },
      onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    } },
    document: {
      readyState: "complete",
      documentElement: { appendChild() {} },
      createElement: tag => tag === "style" ? style : { remove() {}, appendChild() {}, setAttribute() {}, style: { setProperty() {} } },
      addEventListener() {},
      removeEventListener() {},
      getElementById: () => null,
      querySelectorAll: selector => selector === "#dvScores .list-table tr.row" ? rows : selector === `[${attribute}]` ? rows.filter(r => r.hasAttribute(attribute)) : []
    },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe(root, options) { observation = options; }
      disconnect() {}
    },
    requestAnimationFrame: fn => { fn(); return 0; },
    cancelAnimationFrame() {},
    setTimeout: fn => { fn(); return 0; },
    clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync("shared/mackolik-settings.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("content/mackolik-priority-rows.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("content/mackolik-featured-video.js", "utf8"), context);
  assert.deepEqual(rows.map(r => r.hasAttribute(attribute)), [true, true, true, true, false]);
  assert.equal(context.mackolikSettings.normalize("FENERBAHÇE"), "fenerbahce");
  assert.equal(context.mackolikSettings.clean(["Türkiye", "TURKIYE", "", "  Arsenal  "]).join(","), "Türkiye,Arsenal");
  assert.equal(observation.characterData, true);

  const change = teams => {
    for (const listener of listeners) listener({ mackolikHighlightedTeams: { newValue: teams } }, "local");
  };
  change(["Arsenal"]);
  assert.deepEqual(rows.map(r => r.hasAttribute(attribute)), [false, false, false, false, true]);
  resolveInitial({ mackolikHighlightedTeams: ["Barcelona"] });
  await Promise.resolve();
  assert.equal(rows[4].hasAttribute(attribute), true, "Stale initial read must not override a saved edit");
  const added = row("Arsenal", "Chelsea");
  rows.push(added);
  const teamChange = [{ type: "characterData", target: { nodeType: 3, parentElement: { closest: () => true } } }];
  observerCallback(teamChange);
  assert.equal(added.hasAttribute(attribute), true, "Live-added exact matches are highlighted");
  const reserve = row("Real Madrid II", "Arsenal Women");
  rows.push(reserve);
  change(["Real Madrid", "Arsenal"]);
  assert.equal(reserve.hasAttribute(attribute), false, "Reserve and women's teams require their own exact name");
  added.names[0] = "Liverpool";
  // Trigger directly through a settings update to avoid a synchronous RAF mock.
  change(["Arsenal"]);
  assert.equal(added.hasAttribute(attribute), false, "Live text changes remove stale highlights");
  for (const listener of listeners) listener({ mackolikFollowedTeams: { newValue: ["Barcelona", "Arsenal"] } }, "local");
  assert.equal(rows[3].getAttribute(attribute), "followed");
  assert.equal(rows[4].getAttribute(attribute), "main", "Main group wins overlap");
  for (const listener of listeners) listener({ mackolikFollowedTeams: { newValue: [] } }, "local");
  change([]);
  assert.ok(rows.every(r => !r.hasAttribute(attribute)), "Empty list disables highlighting");
  change(["Arsenal"]);
  cleanup();
  assert.ok(rows.every(r => !r.hasAttribute(attribute)), "Module disable clears highlights");
  assert.equal(listeners.size, 0);

  const luminance = hex => {
    const rgb = hex.match(/\w\w/g).map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const background of ["071b26", "102d3a", "261b07", "3a2c10"]) {
    for (const foreground of ["f4fbff", background === "261b07" || background === "3a2c10" ? "ffe082" : "36f9c5", "ffb4ce"]) {
      assert.ok(style.textContent.includes(`#${foreground}`) && style.textContent.includes(`#${background}`));
      const ratio = (luminance(foreground) + .05) / (luminance(background) + .05);
      assert.ok(ratio >= 7, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
      console.log(`Contrast: #${foreground} on #${background} = ${ratio.toFixed(2)}:1`);
    }
  }
  console.log("PASS defaults, Turkish matching, deduplication, live edits, live rows, cleanup, and contrast");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
