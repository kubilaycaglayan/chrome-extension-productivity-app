// Shared, DOM-free helpers for the New Tab module. Loaded by the new tab page,
// the popup (for backup/restore), and the tests.
globalThis.newtabSettings = {
  moduleId: "newtab",
  groupsKey: "newtabGroups",
  backgroundKey: "newtabBackground",
  limits: { groups: 24, bookmarks: 60, name: 60, label: 40, imagePixels: 2560, imageBytes: 4_000_000, credit: 160, suggestions: 8 },
  // Backdrop, the service behind Chrome's own New Tab wallpapers.
  wallpaperHost: /^https:\/\/lh[0-9]\.googleusercontent\.com\/[A-Za-z0-9_\-/]+$/,

  // Soft, dark, low-contrast-against-each-other but high-contrast-with-text.
  colors: [
    ["Ink", "#15181d"],
    ["Slate", "#1b2026"],
    ["Moss", "#16211c"],
    ["Plum", "#1d1822"],
    ["Ocean", "#141d26"],
    ["Cocoa", "#1f1a17"]
  ],
  gradients: [
    ["Dusk", "linear-gradient(160deg, #1a1f2b 0%, #12161d 55%, #191320 100%)"],
    ["Pine", "linear-gradient(160deg, #15201d 0%, #121a1b 55%, #101418 100%)"],
    ["Ember", "linear-gradient(160deg, #241a18 0%, #1a1416 55%, #121115 100%)"],
    ["Tide", "linear-gradient(160deg, #13202b 0%, #121a24 55%, #141722 100%)"]
  ],

  // The same six tints and four gradients, in the same order, walked halfway
  // to white rather than all of it: a light theme that is still a tinted
  // field, matching how the page's own surfaces are pitched.
  lightColors: [
    ["Ink", "#cbced4"],
    ["Slate", "#c6ccd4"],
    ["Moss", "#c6d0c9"],
    ["Plum", "#d0c9d6"],
    ["Ocean", "#c5cfda"],
    ["Cocoa", "#d6cec8"]
  ],
  lightGradients: [
    ["Dusk", "linear-gradient(160deg, #ccd1dc 0%, #c4c9d4 55%, #cfc8d8 100%)"],
    ["Pine", "linear-gradient(160deg, #c7d2cd 0%, #c3cdcd 55%, #c6ccd2 100%)"],
    ["Ember", "linear-gradient(160deg, #dcccc6 0%, #d3c6c8 55%, #cbc7cc 100%)"],
    ["Tide", "linear-gradient(160deg, #c3d1dc 0%, #c4cdd8 55%, #c8cbd6 100%)"]
  ],

  // The flat colour painted under a photo, so a slow or broken image still
  // leaves the page looking like the theme it is in.
  photoBase: { dark: "#0f1216", light: "#e4e7ec" },

  // A stored background always names its dark value, whichever theme picked
  // it: that is the preset's canonical name, so a choice made in daylight
  // still reads as "Moss" after dark. The page looks the face up at paint
  // time instead of rewriting storage on every theme switch.
  presets(scheme) {
    return scheme === "light"
      ? { colors: this.lightColors, gradients: this.lightGradients }
      : { colors: this.colors, gradients: this.gradients };
  },

  // Anything that is not a preset -- a colour from an imported backup, an
  // uploaded photo -- has no counterpart to swap in, so it passes through.
  presetFace(value, scheme) {
    for (const key of ["colors", "gradients"]) {
      const index = this[key].findIndex(([, preset]) => preset === value);
      if (index >= 0) return this.presets(scheme)[key][index][1];
    }
    return value;
  },

  get defaultBackground() {
    return { type: "gradient", value: this.gradients[0][1] };
  },

  // Turns a chrome.bookmarks.getTree() result into groups: each folder on the
  // bookmarks bar becomes a group, and bookmarks sitting loose on the bar are
  // grouped under the bar's own name.
  bookmarkGroups(tree) {
    const containers = [];
    const walk = (nodes) => {
      for (const node of nodes ?? []) {
        if (!node?.children) continue;
        // The unnamed root holds the bar, "Other bookmarks" and so on.
        if (node.title) containers.push(node);
        else walk(node.children);
      }
    };
    walk(Array.isArray(tree) ? tree : []);

    const groups = [];
    for (const container of containers) {
      const loose = [];
      const folders = [];
      for (const child of container.children ?? []) {
        if (child?.url) loose.push({ label: child.title, url: child.url });
        else if (child?.children) folders.push({ name: child.title, bookmarks: this.flattenBookmarks(child) });
      }
      if (loose.length) groups.push({ name: container.title, bookmarks: loose });
      // An empty folder would import as an empty card, so leave it behind.
      groups.push(...folders.filter(folder => folder.bookmarks.length));
    }
    return this.cleanGroups(groups);
  },

  // Nested folders are flattened: a group is one card, not a tree.
  flattenBookmarks(folder, depth = 4) {
    const bookmarks = [];
    const seen = new Set();
    const walk = (node, level) => {
      for (const child of node.children ?? []) {
        if (bookmarks.length >= this.limits.bookmarks) return;
        if (child?.url) {
          const url = this.cleanUrl(child.url);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          bookmarks.push({ label: child.title, url });
        } else if (child?.children && level > 0) {
          walk(child, level - 1);
        }
      }
    };
    walk(folder, depth);
    return bookmarks;
  },

  // Chrome's own New Tab tiles come from the same list.
  topSitesGroup(sites) {
    const bookmarks = this.cleanBookmarks((Array.isArray(sites) ? sites : []).map(site => ({ label: site?.title, url: site?.url })));
    return bookmarks.length ? { id: this.randomId(), name: "Most visited", bookmarks } : null;
  },

  get defaultGroups() {
    return this.cleanGroups([
      { name: "Daily", bookmarks: [
        { label: "Gmail", url: "https://mail.google.com" },
        { label: "Calendar", url: "https://calendar.google.com" },
        { label: "Drive", url: "https://drive.google.com" }
      ] },
      { name: "Dev", bookmarks: [
        { label: "GitHub", url: "https://github.com" },
        { label: "Hugging Face", url: "https://huggingface.co" },
        { label: "Stack Overflow", url: "https://stackoverflow.com" }
      ] }
    ]);
  },

  randomId() {
    return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  },

  // Accepts "github.com" as readily as a full URL; rejects anything that is not
  // http(s) so a stored bookmark can never become a javascript: or data: link.
  cleanUrl(value) {
    if (typeof value !== "string") return "";
    const text = value.trim();
    if (!text) return "";
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return "";
    }
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  },

  labelFor(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "Link";
    }
  },

  // Google's suggest service, the same one the omnibox uses. "client=firefox"
  // is the variant that answers with plain JSON instead of JSONP.
  suggestUrl(query, language = "en-US") {
    const text = String(query ?? "").trim();
    return text ? `https://suggestqueries.google.com/complete/search?client=firefox&hl=${encodeURIComponent(language)}&q=${encodeURIComponent(text)}` : "";
  },

  parseSuggestions(payload) {
    let parsed;
    try {
      parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) return [];
    const seen = new Set();
    return parsed[1]
      .filter(entry => typeof entry === "string" && entry.trim() && !seen.has(entry) && seen.add(entry))
      .slice(0, this.limits.suggestions);
  },

  // Typing a bare host should go there, like the omnibox does; anything else
  // is a Google search.
  searchUrl(query) {
    const text = String(query ?? "").trim();
    if (!text) return "";
    if (!/\s/.test(text) && /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const direct = this.cleanUrl(text);
      if (direct) return direct;
    }
    if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) {
      const direct = this.cleanUrl(text);
      if (direct) return direct;
    }
    return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  },

  // Reordering helpers. `insertAt` always means "before this index in the
  // list as it stands now", which is how a drop position reads. Both return
  // the original list untouched when the move would change nothing.
  reorder(list, fromIndex, insertAt) {
    if (!Array.isArray(list) || fromIndex < 0 || fromIndex >= list.length) return list;
    const target = Math.max(0, Math.min(insertAt, list.length));
    if (target === fromIndex || target === fromIndex + 1) return list;
    const next = list.slice();
    const [item] = next.splice(fromIndex, 1);
    next.splice(target > fromIndex ? target - 1 : target, 0, item);
    return next;
  },

  transfer(source, sourceIndex, target, insertAt) {
    if (!Array.isArray(source) || !Array.isArray(target)) return [source, target];
    if (sourceIndex < 0 || sourceIndex >= source.length) return [source, target];
    const nextSource = source.slice();
    const [item] = nextSource.splice(sourceIndex, 1);
    const nextTarget = target.slice();
    nextTarget.splice(Math.max(0, Math.min(insertAt, nextTarget.length)), 0, item);
    return [nextSource, nextTarget];
  },

  cleanBookmarks(value) {
    if (!Array.isArray(value)) return [];
    const bookmarks = [];
    for (const entry of value) {
      if (bookmarks.length >= this.limits.bookmarks) break;
      const url = this.cleanUrl(entry?.url);
      if (!url) continue;
      const rawLabel = typeof entry?.label === "string" ? entry.label.trim() : "";
      bookmarks.push({
        id: typeof entry?.id === "string" && entry.id ? entry.id : this.randomId(),
        label: (rawLabel || this.labelFor(url)).slice(0, this.limits.label),
        url
      });
    }
    return bookmarks;
  },

  cleanGroups(value) {
    if (!Array.isArray(value)) return [];
    const groups = [];
    for (const entry of value) {
      if (groups.length >= this.limits.groups) break;
      if (!entry || typeof entry !== "object") continue;
      const name = (typeof entry.name === "string" ? entry.name.trim() : "").slice(0, this.limits.name);
      const bookmarks = this.cleanBookmarks(entry.bookmarks);
      if (!name && !bookmarks.length) continue;
      groups.push({
        id: typeof entry.id === "string" && entry.id ? entry.id : this.randomId(),
        name: name || "Bookmarks",
        bookmarks
      });
    }
    return groups;
  },

  cleanBackground(value) {
    const type = value?.type;
    const raw = typeof value?.value === "string" ? value.value.trim() : "";
    if (!raw) return this.defaultBackground;
    if (type === "color" && /^#[0-9a-f]{6}$/i.test(raw)) return { type, value: raw };
    if (type === "gradient" && /^(linear|radial)-gradient\([^;{}"']*\)$/i.test(raw)) return { type, value: raw };
    if (type === "image" && /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(raw)) return { type, value: raw };
    if (type === "google" && this.wallpaperHost.test(raw)) {
      const background = { type, value: raw };
      // Photo credits are shown the way Chrome shows them, so keep them.
      for (const key of ["label", "credit"]) {
        const text = typeof value[key] === "string" ? value[key].trim().slice(0, this.limits.credit) : "";
        if (text) background[key] = text;
      }
      const link = this.cleanUrl(value?.link);
      if (link) background.link = link;
      return background;
    }
    return this.defaultBackground;
  },

  // The page paints a flat colour plus an optional layer, so a failed image
  // still leaves readable text on the field behind it. `scheme` picks which
  // face of a preset gets painted; a wallpaper looks the same in both.
  backgroundCss(value, width = 1920, height = 1080, scheme = "dark") {
    const background = this.cleanBackground(value);
    if (background.type === "color") {
      return { color: this.presetFace(background.value, scheme), image: "none", scrim: false };
    }
    if (background.type === "gradient") {
      return { color: this.presets(scheme).colors[0][1], image: this.presetFace(background.value, scheme), scrim: false };
    }
    const source = background.type === "google"
      ? `${background.value}=w${Math.max(1, Math.round(width))}-h${Math.max(1, Math.round(height))}-p-k-no-nd-mv`
      : background.value;
    return { color: scheme === "light" ? this.photoBase.light : this.photoBase.dark, image: `url("${source}")`, scrim: true };
  }
};
