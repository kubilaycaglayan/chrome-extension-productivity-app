const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const luminance = hex => {
  const rgb = hex.replace("#", "").match(/\w\w/g).map(c => parseInt(c, 16) / 255)
    .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const unique = values => [...new Set(values)];
const collect = (css, property) =>
  unique([...css.matchAll(new RegExp(`(?:^|[\\n ])${property}: (#[0-9a-f]{6}) !important`, "gm"))].map(match => match[1]));

function run() {
  const style = { remove() { style.removed = true; }, parentNode: null };
  let moduleStart, observerCallback, observed;
  const html = { lastElementChild: null, appendChild(node) { html.lastElementChild = node; node.parentNode = html; } };
  const head = { lastElementChild: null, appendChild(node) { head.lastElementChild = node; node.parentNode = head; } };
  const context = vm.createContext({
    productivityModules: { register(id, start) { context.moduleId = id; moduleStart = start; } },
    document: {
      head,
      documentElement: html,
      createElement: () => style
    },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe(root, options) { observed = options; }
      disconnect() { this.disconnected = true; observerCallback = null; }
    }
  });
  vm.runInContext(fs.readFileSync("content/mackolik-dark-theme-rules.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("content/mackolik-dark-theme.js", "utf8"), context);
  assert.equal(context.moduleId, "mackolik-dark-theme");

  const css = context.mackolikDarkThemeRules;
  const cleanup = moduleStart();
  assert.ok(style.textContent.startsWith(css), "The module injects the generated rules");
  const datepickerCss = style.textContent.slice(css.length);
  assert.match(datepickerCss, /#ui-datepicker-div \.ui-datepicker-calendar td \.ui-state-default/, "Date tiles have a dark override");
  assert.match(datepickerCss, /#ui-datepicker-div \.ui-datepicker-calendar td \.ui-state-active/, "The selected day stays distinct");
  // Canli-Sonuclar loads LiveScore.css a second time from inside <body>, so a
  // sheet parked in <head> loses every !important tie. Past </body> it wins.
  assert.equal(html.lastElementChild, style, "Our sheet is the last child of <html>");
  assert.equal(head.lastElementChild, null, "Our sheet is not left behind in <head>");
  assert.equal(observed.subtree, true, "Late site stylesheets are watched for");
  // A site stylesheet appended after ours must not be allowed to win on ties.
  html.lastElementChild = { late: true };
  observerCallback();
  assert.equal(html.lastElementChild, style, "The sheet is moved back to last");
  cleanup();
  assert.equal(style.removed, true, "Disabling the module removes the sheet");

  // The site's own blue page colour and white panel must not survive.
  assert.ok(!/#3866b0/i.test(css), "The site's blue backdrop is replaced");
  for (const selector of ["#master", "tr.alt1", "tr.alt2", ".list-table td", "html, body"]) {
    assert.ok(css.includes(selector), `Generated theme covers ${selector}`);
  }
  // Containers the site paints inline; selector remapping cannot reach these.
  for (const selector of ["#wrapper", '[data-type="_mgwidget"]', ".match-info-wrapper.card"]) {
    assert.ok(css.includes(selector), `Generated theme covers inline-styled ${selector}`);
  }
  // Canli-Sonuclar is the page the extension exists for, and it paints itself
  // from LiveScore.css plus nine inline <style> blocks rather than master.css.
  // Reading only the three sheets linked in <head> left its match table white.
  for (const selector of [".rows-bg", ".dateHeader", ".td_score"]) {
    assert.ok(css.includes(selector), `Generated theme covers live-scores ${selector}`);
  }
  // `.rows-bg` tiles a near-white 1x22 gradient over its own white background,
  // so repainting the colour alone leaves every league header exactly as bright.
  const flat = css.replace(/,\n/g, ", ");
  assert.match(css, /background-image: none !important/, "Light tiling textures are switched off");
  for (const selector of ["\\.rows-bg", "\\.live-score-bg", "\\.livescore-top"]) {
    assert.ok(new RegExp(`${selector}[^{}]*\\{ background-image: none !important`).test(flat),
      `The ${selector} texture is switched off`);
  }
  // Tiles are judged by their own pixels, not by the rule they sit in, so the
  // site's navy menu strip and orange sub-menu must survive the same pass.
  for (const kept of ["menu-bg", "bottom-menu-bg", "standing-bg"]) {
    assert.ok(!new RegExp(`${kept}`).test(css), `The ${kept} brand tile is not referenced`);
  }
  assert.ok(!/#menu-temp \{ background-image: none/.test(flat), "The navy menu tile is kept");
  // A tile that is the only thing painting its row carries a status colour, so
  // it is replaced by a darkened version of itself rather than simply removed.
  assert.ok(/background-image: none !important; background-color: #[0-9a-f]{6} !important/.test(css),
    "Colour-carrying tiles keep their hue as a dark surface");

  // Every rule we emit is !important, so a generic selector of ours outranks any
  // specific site rule of normal weight unless that one is re-emitted too. Left
  // undone, `a, a:visited` repainted the selected menu tab blue on orange.
  const styled = selector => new RegExp(`(^|[\n ,])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,{ ]`, "m").test(css);
  assert.ok(styled("a, a:visited"), "The generic link colour is remapped");
  for (const selector of ["#menu-temp a.menu-rows.selected", ".bottom-menu a.bottom-menu-rows"]) {
    assert.ok(styled(selector), `${selector} outranks the generic link rule`);
  }

  const surfaces = collect(css, "background-color").concat(css.match(/html, body \{ background: (#[0-9a-f]{6})/)[1]);
  const texts = collect(css, "color");
  const borders = collect(css, "border-color");
  assert.ok(surfaces.length > 20 && texts.length > 20, "The generator produced a full palette");

  // Every repainted surface must actually be dark; one missed light panel is
  // the failure mode that makes a generated theme unusable.
  for (const surface of surfaces) {
    assert.ok(luminance(surface) < 0.08, `Surface ${surface} is dark (${luminance(surface).toFixed(3)})`);
  }
  // Gradient stops are surfaces too; a missed light stop shows as a white button.
  const stops = unique([...css.matchAll(/background-image: [^;]*?!important/g)]
    .flatMap(match => match[0].match(/#[0-9a-f]{6}/g) || []));
  assert.ok(stops.length, "Gradient backgrounds are remapped, not dropped");
  for (const stop of stops) {
    assert.ok(luminance(stop) < 0.08, `Gradient stop ${stop} is dark (${luminance(stop).toFixed(3)})`);
  }

  // Borders sit between surfaces, so they stay dark but must not be invisible.
  for (const border of borders) {
    assert.ok(luminance(border) < 0.2, `Border ${border} stays a border, not a surface`);
  }

  // The repo's 7:1 bar, checked across every surface the theme can produce.
  let worst = { ratio: Infinity };
  for (const text of texts) {
    for (const surface of surfaces) {
      const ratio = contrast(text, surface);
      if (ratio < worst.ratio) worst = { ratio, text, surface };
    }
  }
  assert.ok(worst.ratio >= 7, `${worst.text} on ${worst.surface}: ${worst.ratio.toFixed(2)}:1`);
  console.log(`Dark theme: ${surfaces.length} surfaces, ${borders.length} borders, ${texts.length} text colours`);
  console.log(`Worst text contrast: ${worst.text} on ${worst.surface} = ${worst.ratio.toFixed(2)}:1`);
  console.log("PASS generated dark theme covers the site palette, stays last in head, and clears 7:1");
}
run();
