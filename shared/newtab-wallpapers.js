// Client for the Backdrop service that supplies Chrome's own New Tab
// wallpapers. The service speaks protobuf over POST, so this module carries
// just enough of a reader and writer for the two calls we need. Everything is
// best-effort: a failure here leaves the local presets untouched.
globalThis.newtabWallpapers = {
  collectionsUrl: "https://clients3.google.com/cast/chromecast/home/wallpaper/collections?rt=b",
  imagesUrl: "https://clients3.google.com/cast/chromecast/home/wallpaper/collection-images?rt=b",
  cacheKey: "newtabWallpaperCollections",
  cacheMaxAge: 24 * 60 * 60 * 1000,
  host: /^https:\/\/lh[0-9]\.googleusercontent\.com\/[A-Za-z0-9_\-/]+$/,

  /* Protobuf */

  varint(value) {
    const bytes = [];
    let rest = value;
    do {
      const byte = rest & 0x7f;
      rest >>>= 7;
      bytes.push(rest ? byte | 0x80 : byte);
    } while (rest);
    return bytes;
  },

  // Every field we send is length-delimited: a string or a nested message.
  field(number, bytes) {
    return [...this.varint((number << 3) | 2), ...this.varint(bytes.length), ...bytes];
  },

  text(value) {
    return [...new TextEncoder().encode(value)];
  },

  decode(bytes) {
    const fields = new Map();
    let index = 0;
    const varint = () => {
      let value = 0;
      let shift = 0;
      while (index < bytes.length) {
        const byte = bytes[index++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if (!(byte & 0x80)) break;
      }
      return value;
    };
    while (index < bytes.length) {
      const key = varint();
      const number = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === 2) {
        const length = varint();
        if (!fields.has(number)) fields.set(number, []);
        fields.get(number).push(bytes.subarray(index, index + length));
        index += length;
      } else if (wire === 0) {
        varint();
      } else if (wire === 1) {
        index += 8;
      } else if (wire === 5) {
        index += 4;
      } else {
        break;
      }
    }
    return fields;
  },

  string(fields, number) {
    const [value] = fields.get(number) ?? [];
    return value ? new TextDecoder().decode(value) : "";
  },

  /* Requests and responses */

  collectionsRequest(language) {
    return new Uint8Array(this.field(1, this.field(1, this.text(language))));
  },

  imagesRequest(collectionId, language) {
    return new Uint8Array([
      ...this.field(1, this.text(collectionId)),
      ...this.field(2, this.field(1, this.text(language)))
    ]);
  },

  parseCollections(bytes) {
    const collections = [];
    for (const entry of this.decode(bytes).get(1) ?? []) {
      const fields = this.decode(entry);
      const id = this.string(fields, 1);
      const name = this.string(fields, 2);
      const [preview] = fields.get(3) ?? [];
      const previewUrl = preview ? this.string(this.decode(preview), 2) : "";
      if (id && name && this.host.test(previewUrl)) collections.push({ id, name, preview: previewUrl });
    }
    return collections;
  },

  parseImages(bytes) {
    const images = [];
    for (const entry of this.decode(bytes).get(1) ?? []) {
      const fields = this.decode(entry);
      const url = this.string(fields, 2);
      if (!this.host.test(url)) continue;
      const credits = (fields.get(4) ?? []).map(part => this.string(this.decode(part), 1)).filter(Boolean);
      // Backdrop lists the title first, then who made it, then a description.
      images.push({ url, link: this.string(fields, 3), label: credits[0] ?? "", credit: credits[1] ?? "" });
    }
    return images;
  },

  // Backdrop serves any size from one base URL; Chrome asks the same way.
  sized(url, width, height) {
    return this.host.test(url) ? `${url}=w${Math.round(width)}-h${Math.round(height)}-p-k-no-nd-mv` : "";
  },

  async post(url, body, fetchImpl = fetch) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf" },
      body
    });
    if (!response.ok) throw new Error(`Backdrop replied ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },

  async collections(language, fetchImpl) {
    return this.parseCollections(await this.post(this.collectionsUrl, this.collectionsRequest(language), fetchImpl));
  },

  async images(collectionId, language, fetchImpl) {
    return this.parseImages(await this.post(this.imagesUrl, this.imagesRequest(collectionId, language), fetchImpl));
  }
};
