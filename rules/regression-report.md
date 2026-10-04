# Ad blocker regression check

Checked on 2026-10-04 with Chrome 154.0.8037.95, a fresh temporary profile,
and the unpacked extension. The browser accepted both packaged rulesets: 28,690
core rules and 20,736 supplemental rules. These checks are a baseline for list
refreshes, not a claim of complete ad coverage.

| Page type | Page | Loaded | Blocked requests observed in 4.5 s |
| --- | --- | --- | ---: |
| News | theguardian.com/international | Yes, article index visible | 0 |
| Search | bing.com/search?q=technology | Yes, results visible | 2 |
| Forum | forums.macrumors.com | Yes, discussions visible | 1 |
| Video | youtube.com | Yes, landing page loaded | 4 |
| Turkish news | hurriyet.com.tr | Yes, headlines visible | 16 |

The Guardian produced no blocked request during this short capture; its ad calls
may depend on consent or timing. YouTube playback and in-stream ads were not verified. Google Search, Reddit, and AVForums showed bot challenges in this
headless profile and could not be evaluated as page regressions.

The repeatable command `node tools/check-ad-blocker-live.mjs` loads the unpacked
extension in Chrome and checks the fixture in `tests/fixtures/`. The fixture
confirmed that cosmetic filtering hides `#AdBox2` while keeping article and
navigation content, sign-in and checkout buttons, consent controls, and muted
video playback usable. Pausing the site or disabling the module restored the slot immediately; resuming or enabling
hid it again. Chrome's DNR match test confirmed a block, an exception, a
site-specific block, and a paused-site allow rule. The popup's backup import
was tested with valid enabled/disabled states and paused sites, plus an invalid
hostname that left storage and DNR state unchanged. A fresh browser process
with the same profile retained the disabled preference and reconciled the
network rules when the unpacked extension was loaded again. The repeatable
Chrome check also simulated an update reset of the core ruleset, stopped the
service worker, and confirmed that its restart restored the disabled preference.

The control and playback checks use a local fixture. They do not prove that
login, checkout, consent, or playback work on every real site; specific sites
need manual review before making a compatibility claim.
