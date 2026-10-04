globalThis.cookieAccepterSettings = Object.freeze({
  key: "moduleEnabled:cookie-accepter",
  pausedKey: "cookieAccepterPausedSites",
  normalizeHost(value) {
    if (typeof value !== "string" || !value || value.length > 253 || value !== value.trim()) return null;
    const host = value.toLowerCase().replace(/\.$/, "");
    if (host === "localhost") return host;
    if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host) || host.includes("..")) return null;
    const labels = host.split(".");
    if (labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
    return host;
  },
  cleanSites(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(site => this.normalizeHost(site)).filter(Boolean))];
  }
});
