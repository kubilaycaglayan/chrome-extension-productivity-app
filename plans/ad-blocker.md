# Ad blocker module plan

## Goal

Add a reliable, ads-focused blocker to the existing Manifest V3 extension. Block common ad network requests and remove visible ad placements. Keep tracking protection, cookie notices, social widgets, and other annoyance filtering outside this module. A site must be easy to exempt if filtering breaks it.

## Repository fit

- `manifest.json` already uses Manifest V3 and has `<all_urls>` host access. Add `declarativeNetRequestWithHostAccess` and one or more packaged static rulesets under `declarative_net_request.rule_resources`.
- Add an `ad-blocker` row to `popup/popup.js` in the Browser group. The existing `moduleEnabled:*` storage convention and backup/restore loop will then include it. The popup must show the real DNR state and report enable/disable errors, rather than claiming success after only saving storage.
- Implement lifecycle and preference reconciliation in `modules/ad-blocker.js`, imported by `background/service-worker.js`. `content/module-settings.js` handles page scripts, but DNR must be controlled from the service worker.
- Add a narrowly scoped cosmetic script in `content/ad-blocker.js`. Register it in its own `content_scripts` entry so it can run in frames without changing where the existing tab-marker and dark-mode scripts run. Because the top frame already loads `content/module-settings.js`, the cosmetic script should manage its own setting listener instead of injecting that helper twice. It must stop observing and remove injected styles when disabled.

## Implementation

1. **Choose and document filter sources.** Start with an established ads list such as EasyList. Verify its license and attribution requirements before bundling or redistributing it. Pin source revision, download URL, converter version, generation date, and output counts. Do not copy the linked AdBlock extension's package or rules. Keep only rules serving the ads and tracker-blocking goal: EasyList for ads and EasyPrivacy for analytics, telemetry and error reporters. Do not add cookie or general annoyance lists by default.
2. **Build reproducible DNR rulesets.** Add a build script under `tools/` to fetch the pinned source and convert supported network filters to Chrome DNR JSON. Use a maintained converter rather than an ad hoc text substitution. Preserve block exceptions and domain restrictions, use stable rule IDs, reject invalid or over-quota output, and emit a report for skipped or unsupported rules. Commit the generated ruleset so the extension works without a network fetch at runtime. Keep build dependencies out of the runtime extension package.
3. **Control the ruleset.** On install, startup, and extension update, reconcile `moduleEnabled:ad-blocker` against `chrome.declarativeNetRequest.getEnabledRulesets()` and call `updateEnabledRulesets()` as needed. Chrome persists enabled rulesets across browser sessions but resets them from the manifest on extension updates. Serialize preference changes so rapid toggles cannot leave storage and DNR out of sync. Make the popup handle failure visibly.
4. **Add site pause.** Store a normalized, user-editable site allowlist. Apply a higher-priority `allow` rule for requests initiated by paused sites (and relevant frame navigations), while leaving blocking active elsewhere. Reconcile those rules on startup and after import. The popup should offer a “Pause ad blocker on this site” switch, off unless the site is on the list, next to the cookie accepter's. Since a paused entry covers its subdomains, the switch must read as on wherever blocking is actually paused -- including a subdomain of a paused parent -- and turning it off must clear every entry that reaches the site, saying so when that takes a parent domain with it. Do not treat a paused site's network rule as equivalent to global disable. The cosmetic script must honor the same allowlist.
5. **Add cosmetic filtering.** Apply only supported, ads-related selectors, including site-specific exceptions. Filter-list cosmetic syntax is not directly executable CSS; generate a supported subset and report what was skipped. Avoid broad rules such as hiding every element with `ad` in its class. Handle dynamic page updates with bounded work and clean teardown. Exclude cookie notices and unrelated page UI.
6. **Refresh rules deliberately.** Add a documented build/update command and source attribution. Review the generated diff, rule counts, skipped rules, and a regression set before updating the bundled list. Runtime remote updates are not required for the first reliable release; packaged list updates arrive with extension updates.

## Verification and acceptance

- Chrome accepts the unpacked extension and packaged ruleset without rule errors or quota failures.
- On a repeatable test set of ad-supported news, search, forum, video, and local-language sites, ads covered by the list are blocked and obvious empty ad containers are removed. Record misses; do not claim complete coverage of in-stream ads served from the content host.
- Check at least one exception rule and one site-specific rule so the conversion has not broadened a block.
- Global toggle, site pause, browser restart, extension reload/update, and backup/restore all leave storage, popup, network rules, and cosmetic filtering in agreement.
- Check for broken navigation, login, checkout, video playback, and consent controls on representative sites. A paused site should recover on reload.
- Verify the ruleset only covers ads: no cookie-banner hiding, tracker-only rules, or unrelated annoyance rules.

## Known limits

Manifest V3 DNR cannot express every filter-list rule. First-party or server-inserted ads, especially some video ads, may survive. Reliability comes from maintained rules, explicit conversion reporting, exceptions, and regression checks, rather than a promise to remove every ad.

## References

- [Chrome declarativeNetRequest API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [EasyList repository and scope](https://github.com/easylist/easylist)
- [EasyList license](https://easylist.to/pages/licence.html)
- [AdGuard DNR converter](https://github.com/AdguardTeam/tsurlfilter/tree/master/packages/dnr-converter)
