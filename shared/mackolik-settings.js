globalThis.mackolikSettings = {
  key: "mackolikHighlightedTeams",
  followedKey: "mackolikFollowedTeams",
  // Personal lists stay out of the repo: the popup prefills from the gitignored
  // mackolik-teams.local.json when storage holds no teams yet.
  defaults: [],
  normalize(value) {
    return value.toLocaleLowerCase("tr-TR").normalize("NFD")
      .replace(/\p{M}/gu, "").replace(/ı/g, "i").replace(/\s+/g, " ").trim();
  },
  clean(values) {
    const seen = new Set();
    return values.filter(value => {
      if (typeof value !== "string") return false;
      const key = this.normalize(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(value => value.trim());
  }
};
