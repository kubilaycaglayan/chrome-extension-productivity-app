const assert = require("node:assert/strict");
const { setup, fire, queryAll, settle } = require("./newtab-dom.cjs");

// Builds Backdrop-shaped protobuf replies with the page's own encoder.
function collectionsReply(wallpapers, collections) {
  const bytes = [];
  for (const { id, name, preview } of collections) {
    bytes.push(...wallpapers.field(1, [
      ...wallpapers.field(1, wallpapers.text(id)),
      ...wallpapers.field(2, wallpapers.text(name)),
      ...wallpapers.field(3, wallpapers.field(2, wallpapers.text(preview)))
    ]));
  }
  return new Uint8Array(bytes);
}

function imagesReply(wallpapers, images) {
  const bytes = [];
  for (const { url, link, label, credit } of images) {
    bytes.push(...wallpapers.field(1, [
      ...wallpapers.field(2, wallpapers.text(url)),
      ...wallpapers.field(3, wallpapers.text(link)),
      ...wallpapers.field(4, wallpapers.field(1, wallpapers.text(label))),
      ...wallpapers.field(4, wallpapers.field(1, wallpapers.text(credit)))
    ]));
  }
  return new Uint8Array(bytes);
}

const PREVIEW = "https://lh3.googleusercontent.com/proxy/preview-token";
const PHOTO = "https://lh4.googleusercontent.com/proxy/photo-token";

function withBackdrop(extra = {}) {
  const probe = setup({ scripts: ["shared/newtab-wallpapers.js"] });
  const wallpapers = probe.context.newtabWallpapers;
  return setup({
    responses: {
      [wallpapers.collectionsUrl]: collectionsReply(wallpapers, [
        { id: "underwater", name: "Seascapes", preview: PREVIEW },
        { id: "art", name: "Art", preview: PREVIEW },
        { id: "broken", name: "Broken", preview: "https://evil.test/x.jpg" }
      ]),
      [wallpapers.imagesUrl]: imagesReply(wallpapers, [
        { url: PHOTO, link: "https://50reefs.org/", label: "Coral Reefs", credit: "The Ocean Agency" },
        { url: "https://evil.test/hijack.jpg", link: "", label: "Nope", credit: "" }
      ])
    },
    ...extra
  });
}

(async () => {
  const page = withBackdrop();
  await settle();

  /* Presets */
  const [moss] = page.swatches().filter(swatch => swatch.dataset.value === page.settings.colors[2][1]);
  fire(moss, "click");
  await settle();
  assert.equal(page.body.style.backgroundColor, page.settings.colors[2][1]);
  assert.equal(page.body.style.backgroundImage, "none");
  assert.equal(moss.getAttribute("aria-checked"), "true");
  assert.equal(page.body.classList.contains("has-image"), false);

  const [dusk] = page.swatches().filter(swatch => swatch.dataset.value === page.settings.gradients[0][1]);
  fire(dusk, "click");
  await settle();
  assert.equal(page.body.style.backgroundImage, page.settings.gradients[0][1]);

  /* The chooser only reaches Google once it is opened. */
  assert.equal(page.fetches.length, 0, "An ordinary new tab must not call Google");
  assert.equal(page.element("background-panel").hidden, true);
  fire(page.element("background-toggle"), "click");
  await settle();
  assert.equal(page.element("background-panel").hidden, false);
  assert.equal(page.element("background-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(page.fetches.length, 1);
  assert.equal(page.fetches[0].url, page.wallpapers.collectionsUrl);
  assert.equal(page.fetches[0].options.method, "POST");

  const collections = page.options("wallpaper-collections");
  assert.deepEqual(collections.map(tile => tile.getAttribute("aria-label")), ["Seascapes", "Art"],
    "A collection whose preview is not a Google image is dropped");
  assert.equal(queryAll(collections[0], "img")[0].src, `${PREVIEW}=w120-h68-p-k-no-nd-mv`);
  assert.equal(collections[0].getAttribute("aria-pressed"), null, "A collection opens a list, it does not pick a wallpaper");

  /* Opening a collection lists its wallpapers, and brings that list into view:
     left alone, a scrolled panel can swap in a list nowhere near the click. */
  page.element("wallpaper-section").offsetTop = 240;
  page.element("background-panel").scrollTop = 400;
  fire(collections[0], "click");
  await settle();
  assert.equal(page.element("background-panel").scrollTop, 232, "The new list is scrolled to, not left off-screen");
  assert.equal(page.element("wallpaper-collections").hidden, true);
  assert.equal(page.element("wallpaper-back").hidden, false);
  const photos = page.options("wallpaper-images");
  assert.deepEqual(photos.map(tile => tile.getAttribute("aria-label")), ["Coral Reefs"],
    "Images from other hosts are refused");
  assert.equal(photos[0].getAttribute("aria-pressed"), "false", "An unchosen wallpaper says so");

  /* Choosing one stores it with its credit and sizes it for this screen. */
  fire(photos[0], "click");
  await settle();
  assert.equal(photos[0].getAttribute("aria-pressed"), "true", "The chosen wallpaper is marked, like a swatch");
  const stored = page.store[page.settings.backgroundKey];
  assert.equal(stored.type, "google");
  assert.equal(stored.value, PHOTO);
  assert.equal(stored.label, "Coral Reefs");
  assert.equal(stored.credit, "The Ocean Agency");
  assert.equal(stored.link, "https://50reefs.org/");
  // 1280x800 at devicePixelRatio 2.
  assert.equal(page.body.style.backgroundImage, `url("${PHOTO}=w2560-h1600-p-k-no-nd-mv")`);
  assert.ok(page.body.classList.contains("has-image"), "Photos switch the scrim on");
  assert.equal(page.element("attribution").hidden, false);
  assert.equal(page.element("attribution").children[0].textContent, "Coral Reefs — The Ocean Agency");
  assert.equal(page.element("attribution").children[0].href, "https://50reefs.org/");

  fire(page.element("wallpaper-back"), "click");
  assert.equal(page.element("wallpaper-collections").hidden, false);
  assert.equal(page.element("wallpaper-images").hidden, true);

  /* Uploads stay local and are downscaled. */
  page.element("background-image").files = [{ name: "wall.png", size: 2_400_000 }];
  fire(page.element("background-image"), "change");
  await settle();
  await settle();
  const upload = page.store[page.settings.backgroundKey];
  assert.equal(upload.type, "image");
  assert.ok(upload.value.startsWith("data:image/jpeg;base64,"));
  assert.equal(page.lastCanvas.width, 2560, "A 4000px photo is downscaled before storage");
  assert.equal(page.lastCanvas.height, 1920);
  assert.equal(page.element("attribution").hidden, true, "An upload has no credit to show");
  assert.equal(page.fetches.length, 2, "Uploading must not call Google");

  fire(page.element("background-reset"), "click");
  await settle();
  assert.equal(photos[0].getAttribute("aria-pressed"), "false", "Resetting clears the wallpaper's marker");
  assert.equal(page.body.classList.contains("has-image"), false);
  assert.equal(page.body.style.backgroundImage, page.settings.defaultBackground.value);

  /* Another tab's choice follows along. */
  page.storageChange({ [page.settings.backgroundKey]: { newValue: { type: "color", value: page.settings.colors[4][1] } } });
  assert.equal(page.body.style.backgroundColor, page.settings.colors[4][1]);
  page.storageChange({ [page.settings.groupsKey]: { newValue: [{ id: "g9", name: "Elsewhere", bookmarks: [] }] } });
  assert.deepEqual(page.groupNames(), ["Elsewhere"]);
  assert.equal(page.element("drag-hint").hidden, true, "One group needs no drag hint");

  /* A cached collection list is reused instead of refetched. */
  const cached = withBackdrop({
    stored: { [page.wallpapers.cacheKey]: { fetchedAt: Date.now(), collections: [{ id: "art", name: "Art", preview: PREVIEW }] } }
  });
  await settle();
  fire(cached.element("background-toggle"), "click");
  await settle();
  assert.equal(cached.fetches.length, 0, "A fresh cache must not hit the network");
  assert.deepEqual(cached.options("wallpaper-collections").map(tile => tile.getAttribute("aria-label")), ["Art"]);

  /* A stale cache is replaced. */
  const stale = withBackdrop({
    stored: { [page.wallpapers.cacheKey]: { fetchedAt: Date.now() - 2 * page.wallpapers.cacheMaxAge, collections: [{ id: "old", name: "Old", preview: PREVIEW }] } }
  });
  await settle();
  fire(stale.element("background-toggle"), "click");
  await settle();
  assert.equal(stale.fetches.length, 1);
  assert.deepEqual(stale.options("wallpaper-collections").map(tile => tile.getAttribute("aria-label")), ["Seascapes", "Art"]);
  assert.ok(stale.store[page.wallpapers.cacheKey].fetchedAt > Date.now() - 5000, "The cache is refreshed");

  /* Google being unreachable leaves the local presets working. */
  const offline = setup();
  await settle();
  fire(offline.element("background-toggle"), "click");
  await settle();
  assert.equal(offline.element("background-message").hidden, false);
  assert.ok(offline.element("background-message").textContent.includes("Could not reach"));
  assert.equal(offline.options("wallpaper-collections").length, 0);
  const [ocean] = offline.swatches().filter(swatch => swatch.dataset.value === offline.settings.colors[4][1]);
  fire(ocean, "click");
  await settle();
  assert.equal(offline.body.style.backgroundColor, offline.settings.colors[4][1], "Presets still work offline");

  /* Switching the module off strips the page back to the notice. */
  page.toggleModule(false);
  assert.equal(page.element("app").hidden, true);
  assert.equal(page.cards().length, 0);
  assert.equal(page.swatches().length, 0);
  assert.equal(page.options("wallpaper-collections").length, 0);
  assert.equal(page.element("background-panel").hidden, true);
  assert.equal(page.element("attribution").hidden, true);
  assert.equal(page.body.style.backgroundImage, "");
  assert.equal(page.status(), "");
  const before = page.navigations.length;
  page.element("query").value = "ignored";
  fire(page.element("search"), "submit");
  assert.equal(page.navigations.length, before, "A disabled page must not handle the search form");
  page.element("query").value = "ignored too";
  fire(page.element("query"), "input");
  page.flushTimers();
  await settle();
  assert.equal(page.fetches.length, 2, "A disabled page must not ask Google for suggestions");

  /* And switching it back on remounts from storage. */
  page.toggleModule(true);
  await settle();
  assert.equal(page.element("app").hidden, false);
  assert.deepEqual(page.groupNames(), ["Daily", "Dev"], "Remounting renders what storage holds");
  assert.equal(page.swatches().length, page.settings.colors.length + page.settings.gradients.length);

  /* A page opened with the module already off shows only the notice. */
  const off = setup({ stored: { "moduleEnabled:newtab": false } });
  await settle();
  assert.equal(off.element("app").hidden, true);
  assert.equal(off.writes.length, 0, "A disabled page must not touch storage");
  assert.equal(off.fetches.length, 0);

  console.log("PASS newtab background: presets, Google wallpapers, caching, uploads, offline fallback, teardown");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
