const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Backdrop speaks protobuf, so the encoder and decoder carry the risk here.
const context = vm.createContext({ TextEncoder, TextDecoder });
vm.runInContext(fs.readFileSync("shared/newtab-wallpapers.js", "utf8"), context);
const wallpapers = context.newtabWallpapers;

const hex = bytes => Buffer.from(bytes).toString("hex");
// Values cross a realm boundary, so compare their shape rather than identity.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

// Verified against the live service: these are the exact bytes it answers to.
assert.equal(hex(wallpapers.collectionsRequest("en-US")), "0a070a05656e2d5553");
assert.equal(hex(wallpapers.imagesRequest("underwater", "en-US")), "0a0a756e646572776174657212070a05656e2d5553");
assert.equal(hex(wallpapers.collectionsRequest("tr")), "0a040a027472");

// Varints have to cross the single-byte boundary correctly.
same(wallpapers.varint(0), [0]);
same(wallpapers.varint(127), [127]);
same(wallpapers.varint(128), [0x80, 0x01]);
same(wallpapers.varint(300), [0xac, 0x02]);
const long = "x".repeat(300);
const framed = wallpapers.field(1, wallpapers.text(long));
assert.equal(wallpapers.string(wallpapers.decode(new Uint8Array(framed)), 1), long, "Fields longer than 127 bytes survive");

// A reply with repeated groups, nested messages and fields we ignore.
const preview = "https://lh3.googleusercontent.com/proxy/token-1";
const photo = "https://lh6.googleusercontent.com/proxy/token-2";
const collectionsReply = new Uint8Array([
  ...wallpapers.field(1, [
    ...wallpapers.field(1, wallpapers.text("underwater")),
    ...wallpapers.field(2, wallpapers.text("Seascapes")),
    ...wallpapers.field(3, wallpapers.field(2, wallpapers.text(preview))),
    ...wallpapers.varint(6 << 3 | 1), 0, 0, 0, 0, 0, 0, 0, 0,
    ...wallpapers.varint(7 << 3 | 0), ...wallpapers.varint(99)
  ]),
  ...wallpapers.field(1, [
    ...wallpapers.field(1, wallpapers.text("offsite")),
    ...wallpapers.field(2, wallpapers.text("Elsewhere")),
    ...wallpapers.field(3, wallpapers.field(2, wallpapers.text("https://evil.test/x.jpg")))
  ]),
  ...wallpapers.field(1, [...wallpapers.field(2, wallpapers.text("No id"))])
]);
const collections = wallpapers.parseCollections(collectionsReply);
assert.equal(collections.length, 1, "Only Google-hosted, fully named collections are kept");
same(collections[0], { id: "underwater", name: "Seascapes", preview });

const imagesReply = new Uint8Array([
  ...wallpapers.field(1, [
    ...wallpapers.field(2, wallpapers.text(photo)),
    ...wallpapers.field(3, wallpapers.text("https://50reefs.org/")),
    ...wallpapers.field(4, wallpapers.field(1, wallpapers.text("Coral Reefs, New Caledonia"))),
    ...wallpapers.field(4, wallpapers.field(1, wallpapers.text("The Ocean Agency"))),
    ...wallpapers.field(4, wallpapers.field(1, wallpapers.text("A long description nobody needs on screen")))
  ]),
  ...wallpapers.field(1, [...wallpapers.field(2, wallpapers.text("http://lh3.googleusercontent.com/proxy/insecure"))]),
  ...wallpapers.field(1, [...wallpapers.field(2, wallpapers.text("https://lh3.googleusercontent.com.evil.test/proxy/x"))])
]);
const images = wallpapers.parseImages(imagesReply);
assert.equal(images.length, 1, "Insecure and lookalike hosts are refused");
same(images[0], {
  url: photo,
  link: "https://50reefs.org/",
  label: "Coral Reefs, New Caledonia",
  credit: "The Ocean Agency"
});

// Truncated or junk payloads must not throw; the chooser just shows nothing.
assert.equal(wallpapers.parseCollections(new Uint8Array([0x0a, 0x7f, 0x01])).length, 0);
assert.equal(wallpapers.parseImages(new Uint8Array([0xff, 0xff, 0xff])).length, 0);
assert.equal(wallpapers.parseCollections(new Uint8Array()).length, 0);

// Sizing is the one place a URL is rewritten, so it stays host-checked.
assert.equal(wallpapers.sized(photo, 2560, 1440), `${photo}=w2560-h1440-p-k-no-nd-mv`);
assert.equal(wallpapers.sized(photo, 120.4, 68.6), `${photo}=w120-h69-p-k-no-nd-mv`);
assert.equal(wallpapers.sized("https://evil.test/x.jpg", 100, 100), "");

(async () => {
  // A failing request surfaces as a rejection, which the page turns into a note.
  await assert.rejects(
    wallpapers.collections("en-US", () => Promise.resolve({ ok: false, status: 503 })),
    /503/
  );

  let seen;
  const bytes = new Uint8Array([1, 2, 3]);
  await wallpapers.collections("en-US", (url, options) => {
    seen = { url, options };
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(bytes.buffer) });
  });
  assert.equal(seen.url, wallpapers.collectionsUrl);
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers["Content-Type"], "application/x-protobuf");

    console.log("PASS newtab wallpapers: request bytes, response parsing, host checks, failure handling");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
