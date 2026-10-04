# Bundled ad and tracker filters

The generated rules and cosmetic selectors derive from four upstream lists.

EasyList and EasyPrivacy are pinned at revision
`bde0d888ef7c5cb99e9c682b1862988e358d10d6`:

- **EasyList** — ad rules.
  Source: https://github.com/easylist/easylist/tree/bde0d888ef7c5cb99e9c682b1862988e358d10d6/easylist
- **EasyPrivacy** — tracker rules (analytics, telemetry and error reporters).
  Source: https://github.com/easylist/easylist/tree/bde0d888ef7c5cb99e9c682b1862988e358d10d6/easyprivacy

Authors: EasyList authors (https://easylist.to/).
EasyList and EasyPrivacy are each dual licensed under GPL-3.0-or-later and
CC BY-SA 3.0 Unported.
The generated rule data here is distributed under CC BY-SA 3.0 Unported:
https://creativecommons.org/licenses/by-sa/3.0/
EasyList license notice: https://easylist.to/pages/licence.html

Neither EasyList nor EasyPrivacy covers device and mobile-OS telemetry, so two
AdGuard filters supply that:

- **AdGuard Tracking Protection filter** (filter 3) — web counters, analytics
  and mobile-OS analytics endpoints.
- **AdGuard Mobile Ads filter** (filter 11) — mobile ad networks.

Authors: AdGuard (https://github.com/AdguardTeam/AdguardFilters).
Both are licensed under GPL-3.0-only:
https://github.com/AdguardTeam/AdguardFilters/blob/master/LICENSE

The AdGuard repository sources need `!#include` and `!#if` preprocessing, and
their includes point at unpinned URLs, so the build takes the compiled chromium
platform build of each filter instead — includes resolved and platform
conditionals already evaluated for a Chromium extension. Those URLs carry no
commit to pin, so `build-report.json` records each filter's upstream version,
`TimeUpdated` and a SHA-256 of the exact body that was converted.

Each AdGuard build is a single file delimited by section banners, so the build
selects sections by name the way the EasyList lists select files, and records
both the selected and the skipped sections with their rule counts. A section
name that appears upstream without being declared selected or skipped fails the
build, so an upstream rename surfaces at refresh time instead of silently
dropping rules. Skipped by scope: AdGuard's CNAME mail-tracker block (the
separate email-tracker add-on, out of scope here as it is for EasyPrivacy, and
over half of filter 3 by volume), the cookie sections, rules for native
applications, anti-adblock circumvention, content replacement, and the cosmetic
and scriptlet sections. AdGuard's re-inclusion of part of EasyPrivacy is skipped
because EasyPrivacy is already bundled in full.

The files were converted and split for Manifest V3. Network rules use
`@adguard/dnr-converter@2.0.0`; cosmetic rules use the conservative plain-CSS
subset in `tools/ad-blocker-build/cosmetic.mjs` and come from EasyList only,
since EasyPrivacy ships no cosmetic list and the AdGuard cosmetic sections are
not selected. EasyPrivacy's CNAME-tracker and email-tracker lists are separate
upstream add-ons and are not included; neither are the cookie, social or
annoyance lists. `build-report.json` records source URLs and hashes, rule
counts, unsupported rules, and conversion errors.

The cosmetic selectors are precomputed into three artifacts rather than one list
every frame has to filter: `content/ad-blocker-generic.css`, grouped
`display: none !important` rules over the selectors that apply everywhere;
`content/ad-blocker-excepted.js`, the generic selectors at least one host
cancels, which therefore cannot sit in a static stylesheet; and
`content/ad-blocker-domain-rules.js`, the domain-scoped index the service worker
resolves per host. Cookie and consent selectors are excluded at build time
rather than at runtime, so the cookie-accepter module still finds the banners it
clicks.

The stylesheet is emitted as rules of at most 1,000 selectors rather than one
rule over all of them. Blink indexes a rule's selectors with a 13-bit field that
counts `CSSSelector` entries rather than list positions, so a selector starting
past entry 8191 of its rule is parsed, kept, reported by `selectorText` — and
never matched. A single rule over the 12,980 generic selectors silently lost 37%
of them that way.

Every selector is checked by headless Chrome's CSS parser during the build,
because one selector Chrome rejects would drop the whole grouped rule it sits in
instead of only itself, and the generated stylesheet is then parsed back and
asserted to be the expected rules over the expected selector count. Because a
selector Chrome parses is not necessarily one Chrome matches, which is how the
entry limit above went unnoticed, the build also matches: every selector that can
be handed an element gets one, and the stylesheet has to hide it. The build
further asserts, for every host an exception names and a sample of the
domain-scoped hosts, that the three artifacts resolve to exactly the selector set
the unsplit corpus gives that host. `build-report.json` records the resulting
file sizes and counts along with everything dropped on the way.

The stylesheet is registered by the service worker rather than declared in
`manifest.json`, so it can be excluded on paused sites; a declared entry would
apply it everywhere, and Chrome gives a frame no way to detach CSS it injected.
The per-host script is registered separately and stays registered while the
module is off, so a frame already open can restore its own sheet when the setting
returns. Both run at `document_start` in every frame, so generic ad spaces are
hidden before the page's first paint.

The core ruleset is under Chrome's guaranteed 30,000 static rule capacity. It
includes every exception from all four lists and the domain-specific, general
URL and mobile-analytics rules, so a supplemental set that cannot load never
strands a block rule whose exception lives elsewhere; the build fails if an
exception would land outside the core. It fills its remaining capacity from the
pooled flat host lists — EasyList's adservers, EasyPrivacy's tracking servers
and AdGuard's tracking servers — taking major ad networks first, then a stable
hash order so the selection does not drift between refreshes. The lists overlap
heavily on tracker hosts, so the pool is deduplicated against itself and against
the core. The pool is far larger than the guarantee, so the rest overflows into
six supplemental rulesets, each kept under 30,000 rules and each enabled on its
own when the browser has enough shared static rule capacity. The popup reports
when only the core can run. Updates are packaged with extension updates; there
is no runtime list download.

## Refresh

1. Review the upstream EasyList and EasyPrivacy changes and update the pinned
   commit in `tools/ad-blocker-build/build.mjs`. The AdGuard filters are fetched
   at their current published version; compare the recorded version and hash in
   `build-report.json` against the previous build to see what moved.
2. Run `cd tools/ad-blocker-build && npm ci && npm run build` with Node 22+ and
   Chrome installed, since the cosmetic step validates selectors in headless
   Chrome; set `CHROME_PATH` for a nonstandard Chrome location. To regenerate
   only the cosmetic artifacts, for the revision `build-report.json` already
   records, run `node cosmetic.mjs` from that directory instead.
3. Run `node tools/check-ad-blocker-live.mjs` from the repository root with
   Node 22+ and Chrome installed. Set `CHROME_PATH` for a nonstandard Chrome
   location.
4. Review `build-report.json`, the generated diff, source licenses, exception
   coverage, and representative site regressions before shipping. Tracker rules
   break sites more readily than ad rules, so check login, checkout, consent and
   embedded video flows.
5. Optionally re-score coverage with `node tools/score-adblock-test.mjs`.

Limitations: Manifest V3 cannot express every list rule. In-stream ads from a
content host and ads generated in page scripts may remain. Pausing a site does
not reach every frame on it: the stylesheet's `excludeMatches` patterns are
matched against each frame's own URL rather than the top frame's, so a cross-site
frame embedded in a paused page still receives the generic stylesheet. The
per-host selectors do go quiet everywhere on a paused page, since the service
worker decides from the top frame's host. Rules that need
header manipulation, URL rewriting or cookie handling (`$csp`, `$cookie`,
`$removeparam`, `$redirect`, `$replace` and related) are dropped, as are the
AdGuard-only modifiers that have no declarativeNetRequest equivalent (`$app`,
`$stealth`, `$jsinject`, `$urlblock` and related). `$badfilter`, which upstream
uses to disable another rule, is also dropped, so a rule it was meant to switch
off stays active. The build report identifies unsupported syntax and converter
errors.
