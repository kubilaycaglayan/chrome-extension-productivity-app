// Placeholders for the globals this extension's own filtering takes away. A page that
// loads an ad library and then dereferences it from unrelated code throws a ReferenceError
// on the first statement that touches it, and the rest of that function is lost. When the
// function is the one behind a cookie banner's buttons, the banner stops responding to the
// cookie accepter and to the user alike, so the page is left worse than it was unblocked.
//
// A shim is only ever a hole-filler: it names a global the block list is known to remove,
// and gives it the shape the page reads rather than anything the library would do. The
// service worker registers this in the main world at document_start, and only while the ad
// blocker is on and the host is not paused, so it is absent exactly when the real library
// is allowed to load.
(() => {
  const shims = {
    // arsiv.mackolik.com's saveCookieConsent() assigns AdmostClient.isAdsChecked before it
    // writes the choice to localStorage and hides the banner, so with go.admost.com blocked
    // the banner can never be dismissed or remembered -- not by the accepter's click, and
    // not by a real one either. The page only ever reads the property back off the object.
    "mackolik.com": ["AdmostClient"]
  };

  const host = location.hostname.toLowerCase().replace(/\.$/, "");
  for (const [domain, names] of Object.entries(shims)) {
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    for (const name of names) {
      // Never shadow a global that is already there. The property stays plain and writable,
      // so a library that does arrive -- served from a host the list misses, or inlined --
      // overwrites the placeholder with itself on assignment.
      if (name in globalThis) continue;
      globalThis[name] = {};
    }
  }
})();
