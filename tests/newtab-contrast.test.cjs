const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Guards the "readable, low eye-strain" promise: every preset background is
// checked against the text colours the page actually declares.
const css = fs.readFileSync("newtab/newtab.css", "utf8");
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync("shared/newtab-settings.js", "utf8"), context);
const settings = context.newtabSettings;

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `newtab.css must define --${name} as a hex colour`);
  return match[1];
}

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

function over(foreground, alpha, background) {
  const base = Array.isArray(background) ? background : rgb(background);
  return rgb(foreground).map((value, index) => Math.round(value * alpha + base[index] * (1 - alpha)));
}

function rgbHex(channels) {
  return `#${channels.map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

const text = token("text");
const muted = token("muted");
const accent = token("accent");

// Darkest-to-lightest stop of each preset, so both ends of a gradient count.
const backgrounds = [
  ...settings.colors.map(([name, value]) => [name, value]),
  ...settings.gradients.flatMap(([name, value]) => (value.match(/#[0-9a-f]{6}/gi) ?? []).map((stop, index) => [`${name} stop ${index + 1}`, stop])),
  ["Image scrim", "#0a0c10"],
  ["Page default", (css.match(/background-color:\s*(#[0-9a-f]{6})/i) ?? [])[1]]
];

assert.ok(backgrounds.length >= settings.colors.length + settings.gradients.length * 2);

for (const [name, background] of backgrounds) {
  assert.ok(background, `${name} must resolve to a hex colour`);
  const bodyText = contrast(rgb(text), rgb(background));
  const secondary = contrast(rgb(muted), rgb(background));
  // AAA for body copy, comfortably past AA for the quieter labels.
  assert.ok(bodyText >= 7, `${name}: body text contrast is ${bodyText.toFixed(2)}, needs 7`);
  assert.ok(secondary >= 4.5, `${name}: secondary text contrast is ${secondary.toFixed(2)}, needs 4.5`);
  // Soft, not glaring: pure white on near-black would be harsher than this.
  assert.ok(bodyText <= 18, `${name}: body text contrast is ${bodyText.toFixed(2)}, which is harsher than intended`);
}

// Cards and tinted buttons sit on top of the background, so check them too.
const darkest = settings.colors[0][1];
const card = contrast(rgb(text), over("#ffffff", 0.055, darkest));
assert.ok(card >= 7, `Card text contrast is ${card.toFixed(2)}, needs 7`);
const chip = contrast(rgb(accent), over(accent, 0.16, darkest));
assert.ok(chip >= 4.5, `Accent-on-accent contrast is ${chip.toFixed(2)}, needs 4.5`);
const circle = contrast(rgb(text), over("#ffffff", 0.1, rgbHex(over("#ffffff", 0.055, darkest))));
assert.ok(circle >= 7, `The favicon circle's letter fallback is ${circle.toFixed(2)}, needs 7`);
const dialog = contrast(rgb(text), rgb("#121620"));
assert.ok(dialog >= 7, `Dialog text contrast is ${dialog.toFixed(2)}, needs 7`);

// The hard case: a pure-white wallpaper behind the scrim. Everything the page
// draws on top of a photo has to stay readable there.
//
// Every layer below is read out of the stylesheet rather than copied into the
// test, so dialling the scrim up or down is checked rather than assumed.
function rule(selector) {
  const match = css.match(new RegExp(`(?:^|\\})\\s*${selector}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(match, `newtab.css must declare a ${selector} rule`);
  return match[1];
}

function layer(selector, property) {
  const match = rule(selector).match(new RegExp(`${property}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([0-9.]+)\\)`));
  assert.ok(match, `${selector} must paint ${property} with an rgba() colour`);
  return { channels: [1, 2, 3].map(index => Number(match[index])), alpha: Number(match[4]) };
}

function blend({ channels, alpha }, background) {
  return channels.map((value, index) => Math.round(value * alpha + background[index] * (1 - alpha)));
}

const white = [255, 255, 255];
const scrim = blend(layer("body\\.has-image #scrim", "background"), white);
const photoCard = blend(layer("body\\.has-image", "--card"), scrim);
const onPhoto = [
  ["Card text", text, photoCard],
  ["Tile letter in its circle", text, over("#ffffff", 0.1, rgbHex(photoCard))],
  ["Search field text", text, blend(layer(":root", "--field"), scrim)],
  ["Suggestion text", text, blend(layer("#suggestions, #bookmark-suggestions", "background"), scrim)],
  ["Chooser text", text, blend(layer("#background-panel", "background"), scrim)],
  ["Photo credit", muted, blend(layer("body\\.has-image #attribution", "background"), scrim)],
  ["Drag hint", text, blend(layer("body\\.has-image #drag-hint", "background"), scrim)]
];
for (const [name, foreground, background] of onPhoto) {
  const ratio = contrast(rgb(foreground), background);
  assert.ok(ratio >= 4.5, `${name} over a white wallpaper is ${ratio.toFixed(2)}, needs 4.5`);
}
// A photo should still read as a photo: the dimming exists for the text, so it
// stops where the text carries its own backing.
assert.ok(layer("body\\.has-image #scrim", "background").alpha <= 0.45,
  "The scrim must dim a wallpaper, not black it out");
assert.match(css, /body\.has-image \{[^}]*--card:/, "Card surfaces must darken over a photo");

// Focus must stay visible for keyboard use, and motion must be opt-in.
assert.match(css, /:focus-visible\s*\{[^}]*outline:/, "Focus rings must be declared");
assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/, "Transitions must respect reduced motion");
assert.match(css, /color-scheme: dark/, "The page must declare its dark scheme");

console.log("PASS newtab contrast: text, cards, chips and dialogs stay readable on every preset");
