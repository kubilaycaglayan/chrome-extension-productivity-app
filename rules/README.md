# Bundled ad and tracker filters

The generated rules and cosmetic selectors derive from two upstream lists, both
pinned at revision `bde0d888ef7c5cb99e9c682b1862988e358d10d6`:

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

The files were converted and split for Manifest V3. Network rules use
`@adguard/dnr-converter@2.0.0`; cosmetic rules use the conservative plain-CSS
subset in `tools/ad-blocker-build/build.mjs` and come from EasyList only, since
EasyPrivacy ships no cosmetic list. EasyPrivacy's CNAME-tracker and
email-tracker lists are separate upstream add-ons and are not included; neither
are the cookie, social or annoyance lists. `build-report.json` records source
URLs and hashes, rule counts, unsupported rules, and conversion errors.

The core ruleset is under Chrome's guaranteed 30,000 static rule capacity. It
includes every exception from both lists and every site rule, so a supplemental
set that cannot load never strands a block rule whose exception lives elsewhere.
It also carries all tracker rules, and fills its remaining capacity from the
EasyList adserver host pool: major ad networks first, then a stable hash order so
the selection does not drift between refreshes. The pool is far larger than the
guarantee, so the rest overflows into two supplemental rulesets, each kept under
30,000 rules and each enabled on its own when the browser has enough shared
static rule capacity. The popup reports when only the core can run. Updates are
packaged with extension updates; there is no runtime list download.

## Refresh

1. Review the upstream EasyList and EasyPrivacy changes and update the pinned
   commit in `tools/ad-blocker-build/build.mjs`.
2. Run `cd tools/ad-blocker-build && npm ci && npm run build` with Node 22+.
3. Run `node tools/check-ad-blocker-live.mjs` from the repository root with
   Node 22+ and Chrome installed. Set `CHROME_PATH` for a nonstandard Chrome
   location.
4. Review `build-report.json`, the generated diff, source licenses, exception
   coverage, and representative site regressions before shipping. Tracker rules
   break sites more readily than ad rules, so check login, checkout, consent and
   embedded video flows.
5. Optionally re-score coverage with `node tools/score-adblock-test.mjs`.

Limitations: Manifest V3 cannot express every list rule. In-stream ads from a
content host and ads generated in page scripts may remain. Device and OS
telemetry endpoints are out of scope for both lists. The build report identifies
unsupported syntax and converter errors.
