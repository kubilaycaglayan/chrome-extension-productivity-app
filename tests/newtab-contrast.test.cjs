const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Guards the "readable, low eye-strain" promise in both skins: every preset
// background is checked against the text colours the page actually declares,
// and so is every surface the page stacks over a wallpaper.
const css = fs.readFileSync("newtab/newtab.css", "utf8");
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync("shared/newtab-settings.js", "utf8"), context);
const settings = context.newtabSettings;

// The light theme lives in one media block. Splitting it off lets each theme
// be read as its own stylesheet: light rules first, dark baseline behind.
function carveMediaBlock(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `newtab.css must declare ${header}`);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && (depth -= 1) === 0) {
      return { block: source.slice(start, index + 1), rest: source.slice(0, start) + source.slice(index + 1) };
    }
  }
  throw new Error(`${header} is never closed`);
}

const { block: lightCss, rest: baseCss } = carveMediaBlock(css, "@media (prefers-color-scheme: light)");

function rgb(hex) {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
}

function luminance(channels) {
  const [r, g, b] = channels.map(value => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

function blend({ channels, alpha }, background) {
  return channels.map((value, index) => Math.round(value * alpha + background[index] * (1 - alpha)));
}

function over(foreground, alpha, background) {
  return blend({ channels: rgb(foreground), alpha }, Array.isArray(background) ? background : rgb(background));
}

// A theme reads its own block first and falls through to the dark baseline for
// everything it does not restate, exactly as the cascade does.
function themeReader(sources) {
  const find = (pattern, what) => {
    for (const source of sources) {
      const match = source.match(pattern);
      if (match) return match;
    }
    throw new assert.AssertionError({ message: `newtab.css must declare ${what}` });
  };
  const rule = selector => find(new RegExp(`(?:^|\\})\\s*${selector}\\s*\\{([^}]*)\\}`, "m"), `a ${selector} rule`)[1];
  const declaration = (selector, property) => {
    const body = rule(selector);
    const match = body.match(new RegExp(`${property}:\\s*([^;]+);`));
    assert.ok(match, `${selector} must set ${property}`);
    return match[1].trim();
  };
  const layerIn = (text, selector, property) => {
    const match = text.match(new RegExp(`${property}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([0-9.]+)\\)`));
    assert.ok(match, `${selector} must paint ${property} with an rgba() colour`);
    return { channels: [1, 2, 3].map(index => Number(match[index])), alpha: Number(match[4]) };
  };
  return {
    rule,
    // A token may be restated by a later rule in the same block (`body.has-image`
    // re-pitches `--card`), so tokens are read from `:root` specifically.
    token: name => {
      const match = find(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"), `--${name} as a hex colour`);
      return match[1];
    },
    alpha: name => layerIn(rule(":root"), ":root", `--${name}`).alpha,
    layer: (selector, property) => layerIn(rule(selector), selector, property),
    declaration
  };
}

const themes = [
  {
    name: "dark",
    read: themeReader([baseCss]),
    colors: settings.colors,
    gradients: settings.gradients,
    // Worst case for a dark skin: a blinding white wallpaper behind the scrim.
    wallpaper: [255, 255, 255]
  },
  {
    name: "light",
    read: themeReader([lightCss, baseCss]),
    colors: settings.lightColors,
    gradients: settings.lightGradients,
    // And for a light skin, a black one.
    wallpaper: [0, 0, 0]
  }
];

assert.match(baseCss, /color-scheme: dark/, "The page must declare its dark scheme");
assert.match(lightCss, /color-scheme: light/, "The light theme must declare its own scheme");

// Every preset keeps its name and its place in both lists, because a stored
// background is remapped between skins by index.
assert.deepEqual(settings.lightColors.map(([name]) => name), settings.colors.map(([name]) => name),
  "The light colours must mirror the dark ones, in order");
assert.deepEqual(settings.lightGradients.map(([name]) => name), settings.gradients.map(([name]) => name),
  "The light gradients must mirror the dark ones, in order");

for (const theme of themes) {
  const { read } = theme;
  const text = read.token("text");
  const muted = read.token("muted");
  const accent = read.token("accent");
  const where = label => `${theme.name}: ${label}`;

  // The CSS fallback floor and the first preset are the same surface painted
  // from two places, so they have to agree.
  assert.equal(read.declaration(":root", "--page"), theme.colors[0][1], where("--page must be the first colour preset"));
  assert.equal(read.declaration(":root", "--page-image"), theme.gradients[0][1], where("--page-image must be the first gradient preset"));

  // Darkest-to-lightest stop of each preset, so both ends of a gradient count.
  const backgrounds = [
    ...theme.colors.map(([name, value]) => [name, value]),
    ...theme.gradients.flatMap(([name, value]) => (value.match(/#[0-9a-f]{6}/gi) ?? []).map((stop, index) => [`${name} stop ${index + 1}`, stop])),
    ["Photo base", settings.photoBase[theme.name]]
  ];
  assert.ok(backgrounds.length >= theme.colors.length + theme.gradients.length * 2);

  for (const [name, background] of backgrounds) {
    assert.ok(background, where(`${name} must resolve to a hex colour`));
    const bodyText = contrast(rgb(text), rgb(background));
    const secondary = contrast(rgb(muted), rgb(background));
    // AAA for body copy, comfortably past AA for the quieter labels.
    assert.ok(bodyText >= 7, where(`${name}: body text contrast is ${bodyText.toFixed(2)}, needs 7`));
    assert.ok(secondary >= 4.5, where(`${name}: secondary text contrast is ${secondary.toFixed(2)}, needs 4.5`));
    // Soft, not glaring: pure white on near-black would be harsher than this.
    assert.ok(bodyText <= 18, where(`${name}: body text contrast is ${bodyText.toFixed(2)}, which is harsher than intended`));
  }

  // Cards and tinted buttons sit on top of the background, so check them too.
  // A card is a white wash over the page in either skin, which pushes dark
  // text towards its background and light text away from it -- so the preset
  // that leaves the least room is the lightest one in dark mode and the
  // darkest one in light.
  const plate = "#ffffff";
  const byLuminance = theme.colors.map(([, value]) => value).sort((a, b) => luminance(rgb(a)) - luminance(rgb(b)));
  const hardest = theme.name === "light" ? byLuminance[0] : byLuminance[byLuminance.length - 1];
  const card = over(plate, read.alpha("card"), hardest);
  assert.ok(contrast(rgb(text), card) >= 7, where(`Card text contrast is ${contrast(rgb(text), card).toFixed(2)}, needs 7`));
  const chip = contrast(rgb(accent), over(accent, read.alpha("accent-soft"), hardest));
  assert.ok(chip >= 4.5, where(`Accent-on-accent contrast is ${chip.toFixed(2)}, needs 4.5`));
  const circle = contrast(rgb(text), over(plate, read.alpha("circle"), card));
  assert.ok(circle >= 7, where(`The favicon circle's letter fallback is ${circle.toFixed(2)}, needs 7`));
  const dialog = contrast(rgb(text), rgb(read.token("dialog")));
  assert.ok(dialog >= 7, where(`Dialog text contrast is ${dialog.toFixed(2)}, needs 7`));

  // The hard case: the wallpaper this skin copes with worst, behind the scrim.
  // Everything the page draws on top of a photo has to stay readable there.
  //
  // Every layer below is read out of the stylesheet rather than copied into
  // the test, so dialling a scrim up or down is checked rather than assumed.
  const scrim = blend(read.layer("body\\.has-image #scrim", "background"), theme.wallpaper);
  const photoCard = blend(read.layer("body\\.has-image", "--card"), scrim);
  const onPhoto = [
    ["Card text", text, photoCard],
    ["Tile letter in its circle", text, over(plate, read.alpha("circle"), photoCard)],
    ["Search field text", text, blend(read.layer(":root", "--field"), scrim)],
    ["Suggestion text", text, blend(read.layer("#suggestions, #bookmark-suggestions", "background"), scrim)],
    ["Chooser text", text, blend(read.layer("#background-panel", "background"), scrim)],
    ["Photo credit", muted, blend(read.layer("body\\.has-image #attribution", "background"), scrim)],
    ["Drag hint", text, blend(read.layer("body\\.has-image #drag-hint", "background"), scrim)]
  ];
  for (const [name, foreground, background] of onPhoto) {
    const ratio = contrast(rgb(foreground), background);
    assert.ok(ratio >= 4.5, where(`${name} over the worst wallpaper is ${ratio.toFixed(2)}, needs 4.5`));
  }
  // A photo should still read as a photo: the scrim exists for the text, so it
  // stops where the text carries its own backing.
  assert.ok(read.layer("body\\.has-image #scrim", "background").alpha <= 0.45,
    where("The scrim must veil a wallpaper, not paint over it"));
}

assert.match(lightCss, /body\.has-image \{[^}]*--card:/, "Card surfaces must re-pitch over a photo in light too");

// A colour the light theme never restates is a colour it cannot reach, which
// is how a navy plate ends up on a pale page. Tokens must be faced one for
// one, and so must the few rules that still paint a literal.
function rootTokens(source) {
  const match = source.match(/:root\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(match, "A :root block must declare the tokens");
  return Object.fromEntries([...match[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

const darkTokens = rootTokens(baseCss);
const lightTokens = rootTokens(lightCss);
for (const [name, value] of Object.entries(darkTokens)) {
  // `--radius` and friends carry no colour, so they need no second face.
  if (!/#|rgba?\(/.test(value)) continue;
  assert.ok(name in lightTokens, `${name} is a colour with no light face`);
}
for (const name of Object.keys(lightTokens)) {
  assert.ok(name in darkTokens, `${name} exists only in light; the dark baseline must declare it too`);
}

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, "");
const coloured = [...stripComments(baseCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /#[0-9a-f]{3,8}\b|\brgba?\(/i.test(body))
  .map(([, selector]) => selector.trim().replace(/\s+/g, " "))
  .filter(selector => selector !== ":root" && !selector.startsWith("@"));
for (const selector of coloured) {
  assert.ok(lightCss.includes(selector), `${selector} paints a literal colour the light theme never restates`);
}

// Halfway, not all the way: the light skin stays a tinted field. Pure white
// sits at 1.0, and the dark presets are all under 0.02.
for (const [name, value] of [...settings.lightColors, ...settings.lightGradients.flatMap(([label, value]) =>
  (value.match(/#[0-9a-f]{6}/gi) ?? []).map((stop, index) => [`${label} stop ${index + 1}`, stop]))]) {
  const level = luminance(rgb(value));
  assert.ok(level >= 0.45, `${name} is ${level.toFixed(3)}: too dark to read as a light theme`);
  assert.ok(level <= 0.7, `${name} is ${level.toFixed(3)}: the light theme is meant to be half-light, not white`);
}

// Focus must stay visible for keyboard use, and motion must be opt-in.
assert.match(css, /:focus-visible\s*\{[^}]*outline:/, "Focus rings must be declared");
assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/, "Transitions must respect reduced motion");

console.log("PASS newtab contrast: text, cards, chips and dialogs stay readable on every preset, in both themes");
