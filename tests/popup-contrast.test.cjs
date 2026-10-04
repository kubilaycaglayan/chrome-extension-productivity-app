const assert = require("node:assert/strict");
const fs = require("node:fs");

// The popup is one layout in two skins. This checks that both of them are
// legible, and that neither skin quietly loses a colour the other defines.
const css = fs.readFileSync("popup/popup.css", "utf8");

function carveMediaBlock(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `popup.css must declare ${header}`);
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

function rootTokens(source) {
  const match = source.match(/:root\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(match, "A :root block must declare the tokens");
  return Object.fromEntries([...match[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

const dark = rootTokens(baseCss);
const light = rootTokens(lightCss);

// A token defined for one skin and forgotten in the other is how a stray
// navy chip ends up on a pale panel, so neither list may be a subset.
assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).filter(name => name.startsWith("--")).sort(),
  "Every dark token needs a light face, and the light block must invent none of its own");

function rgb(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} must be a six-digit hex colour`);
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
  const [high, low] = [luminance(rgb(foreground)), luminance(rgb(background))].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

// Foreground, background, and the floor each pairing has to clear. Body copy
// is held to AAA; the quieter labels to AA; hairline glyphs to the 3:1 that
// non-text UI needs to stay visible.
const pairings = [
  ["body text on the page", "--text", "--bg", 7],
  ["body text on the module list", "--text", "--surface-sunken", 7],
  ["body text on a raised chip", "--text", "--surface", 7],
  ["body text in a field", "--text", "--field", 7],
  ["body text on a button", "--text", "--button", 7],
  ["body text on a hovered row", "--text", "--row-hover", 7],
  ["body text on a hovered outline item", "--text", "--item-hover", 7],
  ["heading text on the page", "--text-soft", "--bg", 7],
  ["heading text on the module list", "--text-soft", "--surface-sunken", 7],
  ["secondary text on the page", "--muted", "--bg", 4.5],
  ["secondary text on the module list", "--muted", "--surface-sunken", 4.5],
  ["secondary text on a raised chip", "--muted", "--surface", 4.5],
  ["the accent as text on the page", "--cyan", "--bg", 4.5],
  ["the accent as text on the module list", "--cyan", "--surface-sunken", 4.5],
  ["a label on a filled accent", "--on-accent", "--cyan", 4.5],
  ["a label on a hovered filled accent", "--on-accent", "--cyan-strong", 4.5],
  ["the switch knob when on", "--knob-on", "--cyan", 3],
  ["the switch knob when off", "--knob", "--track", 3],
  // An off switch has to look like a control rather than a gap in the row.
  // On and off are told apart by the knob's side and the track's hue, so the
  // two tracks are not held to a ratio against each other.
  ["the switch track against the page", "--track", "--bg", 1.8],
  ["the chevron glyph in its chip", "--chevron-text", "--surface-deep", 4.5],
  ["the chevron glyph once hovered", "--cyan", "--chevron-hover", 4.5],
  ["the row arrow on the page", "--arrow", "--bg", 3],
  ["the outline bullet at depth 1", "--dot-line-1", "--bg", 2.5],
  ["the outline bullet deeper in", "--dot-line-2", "--bg", 2.5],
  ["the focus ring on the page", "--pink", "--bg", 3],
  ["the focus ring on the module list", "--pink", "--surface-sunken", 3],
  // Hairlines and the outline's guide rails are decorative: the structure
  // they trace is also carried by indentation and by the tree's own markup,
  // so they are held to "visible", not to the 3:1 a lone control would need.
  ["an outline guide line on the page", "--tree-line", "--bg", 2.3],
  ["a deeper outline guide line on the page", "--tree-line-deep", "--bg", 2.3],
  ["a hairline around the module list", "--line", "--surface-sunken", 1.35],
  ["a hairline around a raised chip", "--line-strong", "--surface", 1.35],
  ["a hairline around a field", "--line-field", "--field", 1.8],
  ["a hairline around a button", "--line-button", "--button", 1.8],
  ["the switch track's own edge", "--line-track", "--track", 1.8],
  ["the chevron chip's edge", "--line-chevron", "--surface-deep", 1.9],
  ["a hovered outline item's edge", "--line-item-hover", "--item-hover", 1.7]
];

for (const [name, theme] of [["dark", dark], ["light", light]]) {
  for (const [label, foreground, background, floor] of pairings) {
    assert.ok(theme[foreground], `${name} must define ${foreground}`);
    assert.ok(theme[background], `${name} must define ${background}`);
    const ratio = contrast(theme[foreground], theme[background]);
    assert.ok(ratio >= floor, `${name}: ${label} is ${ratio.toFixed(2)}, needs ${floor}`);
  }
  // Soft, not glaring, at both ends.
  const body = contrast(theme["--text"], theme["--bg"]);
  assert.ok(body <= 18, `${name}: body text contrast is ${body.toFixed(2)}, which is harsher than intended`);
}

// Dark stays dark and light stays halfway: the page floor of one skin must be
// near-black, and of the other a tinted grey rather than a white sheet.
const darkFloor = luminance(rgb(dark["--bg"]));
const lightFloor = luminance(rgb(light["--bg"]));
assert.ok(darkFloor <= 0.05, `The dark page floor is ${darkFloor.toFixed(3)}, which is not dark`);
assert.ok(lightFloor >= 0.45 && lightFloor <= 0.7,
  `The light page floor is ${lightFloor.toFixed(3)}: it is meant to be half-light, not white`);

assert.match(baseCss, /color-scheme: dark/, "The popup must declare its dark scheme");
assert.match(lightCss, /color-scheme: light/, "The light theme must declare its own scheme");

// Nothing may paint a raw colour: a literal outside the token blocks is a spot
// the light theme cannot reach.
const literals = baseCss.replace(/:root\s*\{[\s\S]*?\n\s*\}/, "").match(/#[0-9a-f]{3,8}\b|\brgba?\(/gi) ?? [];
assert.deepEqual(literals, [], `popup.css must paint from tokens only; found ${literals.join(", ")}`);

console.log("PASS popup contrast: every surface, label and hairline reads in both themes");
