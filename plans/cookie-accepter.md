# Cookie accepter module plan

## Goal

Automatically choose **Accept all** on recognized cookie-consent banners, including optional analytics and marketing categories. This is the literal behavior implied by “cookie accepter.” It is a consent action, so the module must start **off** until the user explicitly enables it. It should leave unrecognized banners alone instead of guessing.

## Repository fit

- Add `cookie-accepter` to the Browser group in `popup/popup.js`, with text that clearly says it accepts all optional categories. Existing module rows default to enabled (`settings[key] !== false`), so special-case this module to default off in `content/module-settings.js`, popup initialization, and backup export/import. Preserve old backups that lack the setting as off.
- Register `content/cookie-accepter.js` in a separate `content_scripts` entry with `run_at: "document_start"` and `all_frames: true`. Do not change the existing top-frame entry, which also loads unrelated modules, or inject `content/module-settings.js` twice in the top frame. The cookie script should manage its own setting listener. Evaluate `match_about_blank` and `match_origin_as_fallback` for consent UIs in inherited-origin frames; test each before enabling because frame coverage can broaden where the script runs.
- Use `moduleEnabled:cookie-accepter` for the global setting and a separate normalized site pause list. Expose “Pause on this site” in the popup. Include the pause list in export/import and validate imported domains.

## Implementation

1. **Build a consent adapter layer.** Implement explicit detectors and accept-all actions for common consent managers (initial targets: OneTrust, Cookiebot, Didomi, Usercentrics, Quantcast). Each adapter must confirm its own banner or dialog is present, identify its accept-all control, and verify the action was attempted once. Avoid a global search for buttons containing “accept.” Add further adapters only from reproducible site cases.
2. **Handle timing and navigation.** Run when the DOM becomes available, then use a throttled `MutationObserver` for late or re-rendered banners. Support single-page navigation and same-origin frames. Inspect open shadow roots where needed. Set a per-frame/per-banner attempt marker, back off after failed attempts, and stop all observers/listeners when the module is disabled.
3. **Guard the click.** Only act on a visible, enabled control inside a recognized consent dialog. Distinguish “Accept all” from “Save,” “Continue,” newsletter, login, age-gate, and purchase controls. Where an adapter opens preferences, complete the CMP's documented accept-all path and verify the banner closes or consent state changes. Never synthesize consent by writing arbitrary cookies or localStorage values.
4. **Cover languages and exceptions.** Prefer stable CMP-specific selectors and IDs over text. Where text is necessary, use exact, localized phrases within a confirmed banner. Add site-specific fixes only with a test case. Let users pause a site and keep that choice after restart and backup/restore.
5. **Keep the two new modules independent.** The ad blocker must not hide a consent banner before this module can act. The cookie module must still work when ad blocking is off. Test both enabled together because consent scripts and ad network filtering can interact.

## Verification and acceptance

- Use local DOM fixtures for each supported CMP: immediate and delayed banners, multiple languages, an accept-all path behind preferences, duplicate button text elsewhere on the page, and iframed banners. Assert one consent action per banner and no unrelated clicks.
- Run browser checks on real sites using each supported CMP, including fresh profiles with no saved consent and a return visit with consent already stored. Record site, CMP, language, expected action, result, and date so failures are reproducible.
- Confirm global enable/disable, site pause, SPA navigation, frame handling, browser restart, and backup/restore. Toggling off must prevent future actions immediately.
- Check that enabling the module does not affect newsletter popups, login dialogs, age gates, purchase flows, or cookie settings pages without a consent banner.
- Check behavior with the ad blocker both on and off.

## Known limits

Some banners live in inaccessible or closed shadow roots, use unusual scripts, or require a server round trip. Those remain visible until an adapter is added. “Reliable” means verified coverage for named consent managers and safe failure on unknown ones; it cannot mean universal acceptance across every website.

## References

- [Chrome content scripts and frame options](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Referenced extension listing](https://chromewebstore.google.com/detail/accept-all-cookies/ofpnikijgfhlmmjlpkfaifhhdonchhoi)
