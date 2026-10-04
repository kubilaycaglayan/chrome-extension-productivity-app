globalThis.xKeywords = {
  key: "xBlockedWords",
  defaults: [],
  clean(values) {
    const seen = new Set();
    return values.filter(value => {
      if (typeof value !== "string") return false;
      const word = value.trim();
      const key = word.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(value => value.trim());
  }
};
