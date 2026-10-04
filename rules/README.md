# Bundled ad filters

The generated rules and cosmetic selectors derive from EasyList, revision
`bde0d888ef7c5cb99e9c682b1862988e358d10d6`.
Source: https://github.com/easylist/easylist/tree/bde0d888ef7c5cb99e9c682b1862988e358d10d6/easylist
Authors: EasyList authors (https://easylist.to/).
EasyList is dual licensed under GPL-3.0-or-later and CC BY-SA 3.0 Unported.
The generated rule data here is distributed under CC BY-SA 3.0 Unported:
https://creativecommons.org/licenses/by-sa/3.0/
EasyList license notice: https://easylist.to/pages/licence.html

The files were converted and split for Manifest V3. Network rules use
`@adguard/dnr-converter@2.0.0`; cosmetic rules use the conservative plain-CSS
subset in `tools/ad-blocker-build/build.mjs`. No EasyPrivacy, cookie, social,
or annoyance list is included. `build-report.json` records source URLs and
hashes, rule counts, unsupported rules, and conversion errors.

The core ruleset is under Chrome's guaranteed 30,000 static rule capacity.
It includes all site rules and exceptions, prioritizes major ad networks, and
uses a stable hash to distribute other adserver domains. The supplemental
ruleset is enabled when the browser has enough shared static
rule capacity. The popup reports when only the core can run. Updates are
packaged with extension updates; there is no runtime list download.

## Refresh

1. Review the upstream EasyList changes and update the pinned commit in
   `tools/ad-blocker-build/build.mjs`.
2. Run `cd tools/ad-blocker-build && npm ci && npm run build` with Node 22+.
3. Run `node tools/check-ad-blocker-live.mjs` from the repository root with
   Node 22+ and Chrome installed. Set `CHROME_PATH` for a nonstandard Chrome
   location.
4. Review `build-report.json`, the generated diff, source licenses, exception
   coverage, and representative site regressions before shipping.

Limitations: Manifest V3 cannot express every list rule. In-stream ads from a
content host and ads generated in page scripts may remain. The build report
identifies unsupported syntax and converter errors.
