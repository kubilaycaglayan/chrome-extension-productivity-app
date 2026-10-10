// A module switch stores only the choices the user has made, so an absent value is a
// default rather than an answer. Nearly every module is wanted the moment it is installed
// and so defaults to on. The exceptions listed here ask first, and they are read by both
// the content scripts that start modules and the popup that draws their switches.
globalThis.productivityModuleDefaults = Object.freeze({
  // The cookie accepter answers a consent dialog on the user's behalf, and the wrap button
  // puts a control of ours on top of someone else's page. Neither is ours to assume.
  optIn: Object.freeze(["cookie-accepter", "code-wrap"]),
  isEnabled(id, value) {
    return this.optIn.includes(id) ? value === true : value !== false;
  }
});
