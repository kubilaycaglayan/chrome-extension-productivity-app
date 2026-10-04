const assert = require("node:assert/strict");
const { setup, fire, settle } = require("./newtab-dom.cjs");

// The stylesheet follows `prefers-color-scheme` on its own, but the page
// background is painted from script. This covers that half: the right face of
// a preset goes on, it changes when the OS theme does, and the user's choice
// is remembered by name rather than by the colour one theme happened to show.
(async () => {
  const settings = setup().settings;
  const [, ocean] = settings.colors[4];
  const [, lightOcean] = settings.lightColors[4];
  const [, dusk] = settings.gradients[0];
  const [, lightDusk] = settings.lightGradients[0];
  assert.notEqual(ocean, lightOcean, "The two faces of a preset must actually differ");

  /* Opening in light paints the light face of the stored preset. */
  const light = setup({ colorScheme: "light", stored: { [settings.backgroundKey]: { type: "color", value: ocean } } });
  await settle();
  assert.equal(light.body.style.backgroundColor, lightOcean, "A light page paints the preset's light face");

  // The swatches show the faces this theme would paint, while still being
  // addressed by the preset's canonical (dark) value.
  const swatch = light.swatches().filter(node => node.dataset.value === ocean)[0];
  assert.ok(swatch, "A swatch is identified by the preset's canonical value in either theme");
  assert.equal(swatch.style.background, lightOcean, "A swatch shows the face the page would paint");
  assert.equal(swatch.getAttribute("aria-checked"), "true", "The stored preset stays marked in light");

  /* Choosing one in light stores the canonical value, not the light face. */
  const moss = light.swatches().filter(node => node.dataset.value === settings.colors[2][1])[0];
  fire(moss, "click");
  await settle();
  assert.equal(light.store[settings.backgroundKey].value, settings.colors[2][1],
    "A choice is stored by the preset's canonical value, so it survives a theme switch");
  assert.equal(light.body.style.backgroundColor, settings.lightColors[2][1]);

  /* A gradient resolves the same way, down to the flat colour behind it. */
  const dusky = setup({ colorScheme: "light", stored: { [settings.backgroundKey]: { type: "gradient", value: dusk } } });
  await settle();
  assert.equal(dusky.body.style.backgroundImage, lightDusk);
  assert.equal(dusky.body.style.backgroundColor, settings.lightColors[0][1],
    "The colour under a gradient comes from the same theme as the gradient");

  /* Switching the OS theme under an open tab repaints it. */
  const page = setup({ stored: { [settings.backgroundKey]: { type: "color", value: ocean } } });
  await settle();
  assert.equal(page.body.style.backgroundColor, ocean, "A dark page paints the dark face");
  assert.equal(page.schemeListenerCount(), 1, "The page watches for a theme change");
  // Everything the first load wrote is already in; only the switch counts now.
  const writesBefore = page.writes.length;
  page.setColorScheme("light");
  assert.equal(page.body.style.backgroundColor, lightOcean, "Turning the OS light repaints the background");
  assert.equal(page.swatches().filter(node => node.dataset.value === ocean)[0].getAttribute("aria-checked"), "true",
    "The marked swatch stays marked across the switch");
  assert.equal(page.writes.length, writesBefore, "A theme change is not a choice: nothing is written");
  page.setColorScheme("dark");
  assert.equal(page.body.style.backgroundColor, ocean, "And back again");

  /* A wallpaper looks the same in both themes; only the colour behind it, the
     one that shows while the photo loads, follows the theme. */
  const photo = { type: "image", value: `data:image/png;base64,${"A".repeat(16)}` };
  const withPhoto = setup({ stored: { [settings.backgroundKey]: photo } });
  await settle();
  assert.equal(withPhoto.body.style.backgroundColor, settings.photoBase.dark);
  assert.ok(withPhoto.body.classList.contains("has-image"));
  withPhoto.setColorScheme("light");
  assert.equal(withPhoto.body.style.backgroundColor, settings.photoBase.light);
  assert.equal(withPhoto.body.style.backgroundImage, `url("${photo.value}")`, "The photo itself is untouched");
  assert.ok(withPhoto.body.classList.contains("has-image"), "The scrim stays on in either theme");

  /* An imported colour is nobody's preset, so it is painted as given. */
  const custom = setup({ colorScheme: "light", stored: { [settings.backgroundKey]: { type: "color", value: "#3b2d55" } } });
  await settle();
  assert.equal(custom.body.style.backgroundColor, "#3b2d55", "A colour outside the presets passes through untouched");

  /* Switching the module off stops the page listening. */
  page.toggleModule(false);
  assert.equal(page.schemeListenerCount(), 0, "A torn-down page lets go of the media query");
  page.setColorScheme("light");
  assert.equal(page.body.style.backgroundColor, "", "And paints nothing afterwards");

  console.log("PASS newtab theme: presets follow the OS theme by name, live, without rewriting the choice");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
