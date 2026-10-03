// Generates content/mackolik-dark-theme-rules.js from Mackolik's own stylesheets.
//
// The site paints itself from ~180 hard-coded hex colours spread over hundreds of
// selectors, so a hand-written dark theme would be guesswork. Instead we read the
// site's CSS, find every declaration that paints a light surface or dark text, and
// emit the same selector with a hue-preserving dark counterpart. Sprites stay
// untouched, which rules out the usual `filter: invert()` shortcut: master.css
// alone references 64 sprite background-images.
//
// Usage: node tools/build-mackolik-dark-theme.mjs [cacheDir]
// With no cacheDir every input is downloaded fresh. With one, inputs are read
// from it and anything missing is downloaded into it.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { inflateSync } from "node:zlib";

// Every stylesheet the site loads from its own CDN. Canli-Sonuclar -- the page
// the whole extension exists for -- paints its match rows from LiveScore.css, so
// leaving a sheet out does not just miss a panel: master.css text selectors still
// get lightened and then land on a white row that nothing darkened.
const SHEETS = [
  "https://cm.mackolik.com/css5/master.css?v=2.141",
  "https://cm.mackolik.com/css5/mac-detay.css?v=2.141",
  "https://cm.mackolik.com/css5/forum.css?v=2.141",
  "https://cm.mackolik.com/css5/LiveScore.css?v=2.141",
  "https://cm.mackolik.com/css5/TutturCoupon.css?v=2.141",
  "https://cm.mackolik.com/css5/trivia/css/trivia.css?v=2.141",
  "https://cm.mackolik.com/css5/trivia/css/notification.css?v=2.141",
  "https://cm.mackolik.com/css5/trivia/css/Profile.css?v=2.141",
  "https://cm.mackolik.com/css5/trivia/css/ProfileButton.css?v=2.141",
  "https://cm.mackolik.com/css5/trivia/css/Share.css?v=2.141",
  "https://cm.mackolik.com/css5/trivia/css/Tooltip.css?v=2.141"
];

// Pages whose inline <style> blocks are scraped as well. Canli-Sonuclar embeds
// ~37KB across nine of them, including the `.rows-bg` rule that paints every
// league header white -- a rule that exists in no external sheet.
const PAGES = [
  "https://arsiv.mackolik.com/Canli-Sonuclar",
  "https://arsiv.mackolik.com/"
];

// Surfaces lighter than this are repainted.
const LIGHT_SURFACE = 0.45;
// The repo's accessibility bar, applied to generated text over the palest surface.
const MIN_CONTRAST = 7;
// Neutral site greys gain a blue tint so they read as one surface family.
const NEUTRAL_HUE = 205;

const PAGE = "#0a1016";

function parseHex(hex) {
  const value = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex;
  return value.match(/\w\w/g).map(part => parseInt(part, 16));
}

function toHex([r, g, b]) {
  return "#" + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
}

function luminance(rgb) {
  const [r, g, b] = rgb.map(v => v / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return r * .2126 + g * .7152 + b * .0722;
}

function contrast(a, b) {
  const [light, dark] = luminance(a) > luminance(b) ? [a, b] : [b, a];
  return (luminance(light) + .05) / (luminance(dark) + .05);
}

function toHsl([r, g, b]) {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? ((gg - bb) / d + (gg < bb ? 6 : 0))
    : max === gg ? (bb - rr) / d + 2
    : (rr - gg) / d + 4;
  return [h * 60, s, l];
}

function toRgb([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < .5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = t => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hue = ((h % 360) + 360) % 360 / 360;
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255];
}

// Achromatic site greys carry no hue to preserve, so they adopt the theme's blue.
function tint([h, s, l]) {
  return s < .08 ? [NEUTRAL_HUE, .22, l] : [h, Math.min(s, .35), l];
}

function darkenSurface(rgb) {
  const [h, s, l] = tint(toHsl(rgb));
  return toRgb([h, s, 0.07 + (1 - l) * 0.15]);
}

function darkenBorder(rgb) {
  const [h, s, l] = tint(toHsl(rgb));
  return toRgb([h, s, 0.18 + (1 - l) * 0.12]);
}

// Text keeps its hue but is lifted until it clears MIN_CONTRAST on `backdrop` --
// the palest surface this run produces -- so no mapped colour lands unreadable.
// Only ever lifts: a colour that already clears the bar is left alone upstream.
function lightenText(rgb, backdrop) {
  const [h, s] = toHsl(rgb);
  const saturation = s < .08 ? .15 : Math.min(s, .7);
  let lightness = 0.72;
  // Compare the rounded value: 8-bit quantisation can drop a borderline
  // colour back under the bar after it is written out as hex.
  const quantise = l => parseHex(toHex(toRgb([h, saturation, l])).slice(1));
  let result = quantise(lightness);
  while (lightness < 0.98 && contrast(result, backdrop) < MIN_CONTRAST) {
    lightness += 0.01;
    result = quantise(lightness);
  }
  return result;
}

const HEX = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

// The sheets reach for a keyword about as often as a hex -- `background: white`
// alone appears 58 times -- so they are folded to hex before anything is matched.
const NAMED = { whitesmoke: "#f5f5f5", white: "#ffffff", black: "#000000", gray: "#808080", red: "#ff0000" };
const NAMES = new RegExp(`\\b(${Object.keys(NAMED).join("|")})\\b`, "gi");

function normalise(value) {
  // Keywords inside url() would be part of a filename, not a colour.
  return value.replace(/url\([^)]*\)/gi, match => match.replace(NAMES, name => name.replace(/./g, "_")))
    .replace(NAMES, name => NAMED[name.toLowerCase()]);
}

function rules(css) {
  // Flatten @media blocks: the site only uses them for widths, which we keep.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selector: match[1].trim(), body: match[2] }))
    .filter(rule => rule.selector && !rule.selector.startsWith("@") && !rule.selector.includes("{"));
}

// A tiling background image is the texture of a surface, not an icon: the site's
// 94 sprites are all `no-repeat`, while every one of its 32 tiled images is a
// few pixels wide. `.rows-bg` tiles a 1x22 near-white gradient *over* its own
// `background-color: white`, so repainting only the colour leaves the league
// headers exactly as bright as they were.
const TILING = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i;
const REPEATS = /\brepeat(-x|-y)?\b/i;

function tiledImage(property, value) {
  if (!/^background(-image)?$/.test(property)) return null;
  if (!REPEATS.test(value) || /\bno-repeat\b/i.test(value) || /gradient/i.test(value)) return null;
  return value.match(TILING)?.[1] ?? null;
}

// Whether a tile should go is a property of the image, not of the rule: the same
// `repeat-x` declaration carries both the near-white strip behind the match rows
// and the brand navy behind the menu. So the tiles are fetched and measured.
// Only the handful of PNG shapes the site actually ships are decoded; anything
// else returns null, which leaves the image in place.
function pngAverage(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  let width = 0, height = 0, depth = 0, type = 0, palette = null;
  const data = [];
  for (let at = 8; at + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const name = buffer.toString("ascii", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (name === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; type = body[9];
      if (depth !== 8 || body[12] !== 0) return null; // 8-bit, non-interlaced only
    } else if (name === "PLTE") palette = body;
    else if (name === "IDAT") data.push(body);
    else if (name === "IEND") break;
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || !width || !height) return null;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      pixels[y * stride + x] = (line[x] + add) & 0xff;
    }
  }
  // Transparent pixels show the surface underneath, so they are left out of the
  // average rather than counted as black.
  const total = [0, 0, 0];
  let counted = 0;
  for (let i = 0; i < width * height; i++) {
    const at = i * channels;
    let rgb, alpha = 255;
    if (type === 3) { const entry = pixels[at] * 3; rgb = [palette[entry], palette[entry + 1], palette[entry + 2]]; }
    else if (type === 0) rgb = [pixels[at], pixels[at], pixels[at]];
    else if (type === 4) { rgb = [pixels[at], pixels[at], pixels[at]]; alpha = pixels[at + 1]; }
    else if (type === 6) { rgb = [pixels[at], pixels[at + 1], pixels[at + 2]]; alpha = pixels[at + 3]; }
    else rgb = [pixels[at], pixels[at + 1], pixels[at + 2]];
    if (alpha < 128) continue;
    total[0] += rgb[0]; total[1] += rgb[1]; total[2] += rgb[2]; counted++;
  }
  return counted ? total.map(sum => sum / counted) : null;
}

function build(sheets) {
  const surfaces = new Map();
  const texts = new Map();
  const borders = new Map();
  const gradients = new Map();
  const textures = new Map();
  for (const css of sheets) {
    for (const { selector, body } of rules(css)) {
      const declarations = body.split(";");
      for (const declaration of declarations) {
        const split = declaration.indexOf(":");
        if (split < 0) continue;
        const tile = tiledImage(declaration.slice(0, split).trim().toLowerCase(), declaration.slice(split + 1));
        if (tile) textures.set(selector, tile);
      }
      for (const declaration of declarations) {
        const split = declaration.indexOf(":");
        if (split < 0) continue;
        const property = declaration.slice(0, split).trim().toLowerCase();
        const value = normalise(declaration.slice(split + 1).trim());
        const hexes = [...value.matchAll(HEX)].map(match => match[1].toLowerCase());
        if (!hexes.length) continue;
        // Gradients keep their shape; every light stop is remapped in place.
        if (/gradient/i.test(value)) {
          if (!/^background(-image)?$/.test(property) || !hexes.some(hex => luminance(parseHex(hex)) > LIGHT_SURFACE)) continue;
          gradients.set(selector, value.replace(HEX, match => {
            const stop = parseHex(match.slice(1));
            return luminance(stop) > LIGHT_SURFACE ? toHex(darkenSurface(stop)) : match;
          }));
          continue;
        }
        if (hexes.length > 1 && !property.startsWith("border")) continue;
        const rgb = parseHex(hexes[0]);
        if (/^background(-color)?$/.test(property) && luminance(rgb) > LIGHT_SURFACE) {
          surfaces.set(selector, toHex(darkenSurface(rgb)));
        } else if (property === "color") {
          // Which text needs lifting depends on the palest surface this run
          // emits, which is not known yet -- so collect every colour and let
          // the resolve pass below drop the ones that already read fine.
          texts.set(selector, rgb);
        } else if (/^border(-(top|right|bottom|left))?(-color)?$/.test(property) && luminance(rgb) > LIGHT_SURFACE) {
          borders.set(selector, toHex(darkenBorder(rgb)));
        }
      }
    }
  }
  // Text is resolved last: its floor is the palest surface this run emitted,
  // which is only known once every background has been mapped.
  const backdrop = [...surfaces.values(), PAGE]
    .map(hex => parseHex(hex.slice(1)))
    .reduce((a, b) => luminance(a) > luminance(b) ? a : b);
  // Colours that already clear the bar are kept rather than dropped, and emitted
  // unchanged. Every rule we write carries !important, so dropping one would let
  // a generic selector of ours (`a, a:visited`) outrank a specific site rule that
  // is merely normal weight (`#menu-temp a.menu-rows.selected { color:#FFF }`) --
  // which is what turned the selected menu tab blue-on-orange. Re-emitting the
  // whole set at one weight keeps the site's own specificity order intact.
  for (const [selector, rgb] of texts) {
    texts.set(selector, toHex(contrast(rgb, backdrop) >= MIN_CONTRAST ? rgb : lightenText(rgb, backdrop)));
  }
  return { surfaces, texts, borders, gradients, textures, backdrop: toHex(backdrop) };
}

// Selectors that share a colour collapse into one rule to keep the sheet small.
function group(map, property) {
  const byColour = new Map();
  for (const [selector, colour] of map) {
    if (!byColour.has(colour)) byColour.set(colour, []);
    byColour.get(colour).push(selector);
  }
  return [...byColour].map(([colour, selectors]) =>
    `${selectors.join(",\n")} { ${property}: ${colour} !important; }`).join("\n");
}

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

// Cached filenames have to stay unique: several trivia sheets would otherwise
// collide with each other on basename alone.
function cacheName(url) {
  return url.replace(/^https?:\/\//, "").split("?")[0].replace(/[^\w.-]+/g, "_");
}

// With a cache directory the tool reads what is already there and downloads only
// what is missing, so a rebuild is reproducible and reviewable: the inputs that
// produced a given sheet stay on disk next to it.
async function fetchBytes(url, dir) {
  const cached = dir && `${dir}/${cacheName(url)}`;
  if (cached) {
    const hit = await readFile(cached).catch(() => null);
    if (hit) return hit;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (cached) { await mkdir(dir, { recursive: true }); await writeFile(cached, bytes); }
  return bytes;
}

const fetchText = async (url, dir) => (await fetchBytes(url, dir)).toString("utf8");

async function load(dir) {
  const sheets = await Promise.all(SHEETS.map(url => fetchText(url, dir)));
  const pages = await Promise.all(PAGES.map(url => fetchText(url, dir)));
  // Each <style> block is treated as its own sheet; concatenating them could
  // glue a block ending mid-comment onto the next one's first selector.
  const inline = pages.flatMap(html => [...html.matchAll(STYLE_BLOCK)].map(match => match[1]));
  return { sheets, inline };
}

const { sheets: external, inline } = await load(process.argv[2]);
const sheets = [...external, ...inline];
const { surfaces, texts, borders, gradients, textures, backdrop } = build(sheets);

// Measure every tiled image and keep only the ones that are already dark enough
// to belong in the theme -- the navy menu strip stays, the near-white row strip
// goes. A tile we cannot resolve or decode is left alone.
const sampled = new Map();
for (const url of new Set(textures.values())) {
  const absolute = url.startsWith("//") ? `https:${url}` : url.startsWith("http") ? url : null;
  if (!absolute) continue;
  const average = await fetchBytes(absolute, process.argv[2]).then(pngAverage).catch(() => null);
  if (average) sampled.set(url, average);
}
const dropped = new Map();
for (const [selector, url] of textures) {
  const average = sampled.get(url);
  if (!average || luminance(average) <= LIGHT_SURFACE) continue;
  // A tile carrying no colour of its own is the only thing painting that row --
  // dropping it outright would erase a status tint, so its average is darkened
  // into a background-color unless the rule already supplies one.
  dropped.set(selector, surfaces.has(selector) ? null : toHex(darkenSurface(average)));
}
const textureRules = [...dropped].map(([selector, replacement]) => replacement
  ? `${selector} { background-image: none !important; background-color: ${replacement} !important; }`
  : `${selector} { background-image: none !important; }`).join("\n");
// A handful of containers are painted from inline style attributes, which no
// stylesheet selector can be remapped to reach. Author `!important` still wins
// over a non-important inline style, so they are listed explicitly.
const PANEL = toHex(darkenSurface(parseHex("ffffff")));
// The live-score poller stamps its own colours onto score cells as it refreshes,
// so these are the colours of elements, not of selectors; they are lifted through
// the same lightenText so they track MIN_CONTRAST with the rest of the palette.
const SCORE_RED = toHex(lightenText(parseHex("dd0000"), parseHex(backdrop.slice(1))));
const LINK_ORANGE = toHex(lightenText(parseHex("e36a06"), parseHex(backdrop.slice(1))));
const INLINE = `#wrapper,
[data-type="_mgwidget"] { background: ${PAGE} !important; }

.match-info-wrapper.card { background-color: ${PANEL} !important; }

.td_score span[style] { color: ${SCORE_RED} !important; }

a.vol2[style] { color: ${LINK_ORANGE} !important; }`;

const css = [
  `/* Generated by tools/build-mackolik-dark-theme.mjs. Do not edit by hand. */`,
  `html { color-scheme: dark !important; }`,
  `html, body { background: ${PAGE} !important; }`,
  group(surfaces, "background-color"),
  [...gradients].map(([selector, value]) => `${selector} { background-image: ${value} !important; }`).join("\n"),
  textureRules,
  group(borders, "border-color"),
  group(texts, "color"),
  INLINE
].join("\n\n");

await writeFile("content/mackolik-dark-theme-rules.js",
  `// Generated by tools/build-mackolik-dark-theme.mjs. Do not edit by hand.\n` +
  `// Regenerate after Mackolik ships a new master.css version.\n` +
  `globalThis.mackolikDarkThemeRules = ${JSON.stringify(css)};\n`);

console.log(`${external.length} sheets + ${inline.length} inline blocks`);
console.log(`surfaces ${surfaces.size}, tiles ${textures.size} (${sampled.size} decoded, ${dropped.size} dropped), gradients ${gradients.size}, borders ${borders.size}, text ${texts.size}, palest surface ${backdrop}, ${css.length} bytes`);
