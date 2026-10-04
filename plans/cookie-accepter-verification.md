# Cookie accepter verification log

Checked 2026-10-04 from a fresh temporary Chrome profile using `tools/check-cookie-live.cjs`. The runner enables the module in a temporary browser context, records clicks, visible CMP controls, consent cookies, and selected local storage keys, then reloads the page to check the return visit.

| Site | CMP | Language / expected action | Fresh visit | Return visit |
| --- | --- | --- | --- | --- |
| `www.onetrust.com` | OneTrust | English; click `#onetrust-accept-btn-handler` once | One click (`Allow All`); OneTrust consent cookies present | No click; no visible banner |
| `www.cookiebot.com` | Cookiebot | English; click Cookiebot allow all once | One click (`CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll`); `CookieConsent` present | No click; no visible banner |
| `sandbox.didomi.io/cmp.html` | Didomi | English; accept after resetting the demo | Demo reset, then one click (`didomi-notice-agree-button`); `didomi_token` present | No click; no visible banner |
| `radiocomercial.pt/passou` | Quantcast Choice | Portuguese; accept all via `CONCORDO` | One click (`accept-btn`); `euconsent-v2` and `gbc_consent` present; banner controls removed | No click; no accept control |
| `usercentrics.com/product-demo` | Usercentrics | No consent banner was rendered in this fresh profile/region | No action to verify | No action to verify |

Usercentrics remains unverified on a real banner because `usercentrics.com/product-demo`, `hornbach.de`, `heise.de/download`, `fischer.cz`, `deinhandy.de`, and `global.flixbus.com/bus` did not render one in this test environment. Its local fixture verifies the banner container, open shadow root traversal, localized action control, and unrelated settings-page guard. Live coverage should be repeated from a region/profile where a Usercentrics banner is shown.

The browser fixture suite also covers immediate and delayed banners, a preference path, five CMP action shapes, iframe and inherited `about:blank` frames, shadow DOM, global disable, site pause, no-banner settings pages, and unrelated controls.

## Follow-up verification

On 2026-10-04, the local browser fixture suite passed with an isolated Chrome for Testing binary. The test now requires `CHROME_BINARY` explicitly; it never launches system Chrome implicitly. Without that variable, the Node suite runs static/settings assertions and skips browser startup. The full repository Node test loop passes in this safe mode as well.

Live Usercentrics coverage is still pending because no tested site displayed its consent layer in the prior run. The extension-level browser restart check also remains pending: this environment's Chrome for Testing launch did not load an unpacked MV3 extension, so persistent `chrome.storage.local` across an actual extension restart was not established by that attempt.

## Benchmark corpus and scoring

There is no public scored test page for cookie accepters the way `adblock.turtlecute.org` scores the ad blocker, so the corpus comes from DuckDuckGo's autoconsent project, which maintains per-CMP site lists and a measured coverage report. `tools/refresh-cookie-cmp-sites.mjs` snapshots the site lists and CMP labels into `tests/fixtures/cookie-cmp-sites.json`: five static fake-CMP pages, 140 live sites behind the five CMPs this module has adapters for, and 729 sites behind CMPs it does not cover. Only site lists and labels are copied, as an attributed snapshot of MPL-2.0 data; no autoconsent rule code enters this repository.

`tools/score-cookie-test.mjs` scores them. Each site is visited twice in throwaway browser contexts: once with the module disabled, to establish that a consent banner is really shown from this region, and once with it enabled. Banner detection is independent of the module's own selectors — an accept-style control inside a nearby block of consent text counts as a banner, whoever built it — so the harness cannot flatter the adapters it is testing. A site passes only when exactly one accept control is clicked, the banner stops offering an accept control, a new consent cookie or storage key appears, and a reload produces no second click. Sites that show no banner, show a notice-only banner with nothing to accept, or show a banner only in the baseline visit are reported but never scored.

Run it with an isolated browser and a Node that has a global `WebSocket`:

```
CHROME_BINARY=/path/to/chrome-for-testing node tools/score-cookie-test.mjs --set=fixtures,adapters
```

Long runs are best taken in chunks with `--offset`/`--limit`; a headless browser that has been through a few hundred ad-heavy pages can die, after which every later site scores as an error.

### Results, 2026-10-04

Chrome for Testing 154, requests originating in Turkey, so the region-specific banners in the corpus (it is built from DE/GB/US crawls) often did not render: 76 of the 140 live sites showed no banner at all.

| Group | Pass | Scored | Not scored |
| --- | --- | --- | --- |
| OneTrust | 14 | 17 (82%) | 13 no banner, 4 notice-only, 2 baseline-only, 2 errors |
| Cookiebot | 8 | 11 (73%) | 13 no banner, 8 notice-only |
| Quantcast | 4 | 4 (100%) | 9 no banner, 1 error |
| Usercentrics | 3 | 10 (30%) | 20 no banner |
| Didomi | 0 | 0 | 21 no banner |
| Static fake-CMP pages | 0 | 5 (0%) | — |
| **Live total** | **29** | **42 (69%)** | |

A 90-site sample of the out-of-scope set (CMPs with no adapter) scored 0 of the 23 sites that showed an acceptable banner, with 62 showing no banner and 5 erroring. That is the module's documented behavior rather than a defect, and it is the size of the remaining coverage gap: run it with `--set=other`.

The five static pages score zero by design: they are unbranded fake banners, and the module is adapter-only, so it correctly leaves them alone. Didomi could not be exercised at all from this region. Quantcast only reads as 100% once the harness stops counting the empty `#qc-cmp2-container` shell that the CMP leaves behind after acceptance; `tools/check-cookie-live.cjs` confirmed independently that consent is stored and the controls are removed on those sites.

### Failures worth fixing

Each of these was found by the first scored run and is resolved below unless marked otherwise.

- **Banners that fade in are never retried.** On `www.tillamook.com` the OneTrust banner is inserted at `opacity: 0` with `transition: all` and becomes opaque a few seconds later through the transition alone. `visible()` rejects a zero-opacity element, and a CSS transition mutates no attribute, so the `MutationObserver` never fires again and the banner is never reconsidered. Reproduced independently with `tools/check-cookie-live.cjs`: no click on either the fresh or the return visit. A bounded retry while a recognized dialog is on the page would close this.
- **Cookiebot's non-opt-in layout has a different accept button.** `www.poessl-group.de` and `www.chamaeleon-reisen.de` render `#CybotCookiebotDialogBodyButtonAccept` ("Allow all") instead of `#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll`, which is the adapter's only Cookiebot selector.
- **The Usercentrics dialog selector points at a wrapper with no layout box.** On `docs.typo3.org` the accept control `#uc-btn-accept-banner` sits under `#uc-central-banner-modal`, while `#uc-banner-modal` — the adapter's selector — has no client rects, so `visible()` rejects it and the adapter never looks inside. Most of the Usercentrics misses are this layout, which is why that adapter scores lowest.
- **Duplicate CMP instances leave a second banner.** `www.seur.com` renders two OneTrust banner instances (duplicate `#onetrust-pc-btn-handler` ids). The accept click registers and the return visit is clean, but one banner is still on screen during the first visit.
- Sites the corpus labels as a supported CMP sometimes serve a different one (`tfl.gov.uk` uses GOV.UK's own banner, `www.commerzbank.de` a `cookiebox_container_root` widget). Those are reported as unrecognized, which is the documented behavior for unknown banners, not a regression.

## Adapter fixes, 2026-10-04

Five changes to `content/cookie-accepter.js`, each aimed at a failure named above or at a banner shape the module had no path to at all.

- **A bounded poll.** A CSS transition changes no attribute and inserts no node, so nothing wakes the `MutationObserver` when a banner fades in. The module now polls every 500 ms while an unhandled recognized dialog is on the page: 15 s from the last sighting, capped at 30 s per page load, and reopened on SPA navigation. This also covers a second banner instance appearing after the first is accepted, since the scan stops after one click.
- **Cookiebot's non-opt-in accept button.** `#CybotCookiebotDialogBodyButtonAccept` joins the adapter's action list.
- **Dialog wrappers no longer need a layout box.** `visible()` takes a `requireBox` flag; a dialog is now judged on its visibility chain alone, while the control that actually gets clicked still has to occupy space. `#uc-central-banner-modal` joins the Usercentrics dialog list.
- **OneTrust's preference centre raised as the banner.** On `www.coca-cola.com` the preference centre *is* the first-visit banner, so the adapter's "only act on a preference centre this module opened" rule left it alone forever. It is now also accepted when it is an overlay and the page is still inside the search window — which keeps the guard that matters, that a preference centre opened later by the reader on a settings page is never touched. The `/settings` fixture asserts exactly that.
- **A fallback for sites with no CMP.** Deliberately narrow: an exact accept-all phrase from the module's own list, on a button or `role="button"` (never a bare link), inside an ancestor within eight levels that is pinned (`position: fixed`/`sticky`, `<dialog>`, `role="dialog"`, or `aria-modal`) and carries 40-4000 characters of consent prose. It fires at most once per page, only when no recognized CMP dialog is present, and only inside the search window. `www.mackolik.com`'s `.cookie-consent-rectangle` is the shape it was written against; `tools/check-cookie-live.cjs` confirms one click on `Tümünü Kabul Et`, no banner left, `cookieConsent` stored, and no second click on the return visit.

Label matching was also reading `toLocaleLowerCase()` only, which maps "I agree" to "ı agree" under a Turkish locale and stopped it matching; labels are now tested against both the locale-aware and the invariant lowercase form. The shadow-root walk is no longer redone on every mutation, only when a mutation changed the tree's shape or when a poll tick fires, so the added polling costs less than the scanning it replaces.

`tools/score-cookie-test.mjs` had to change with it: a bespoke banner has no adapter selector, so a click now counts as the module's when it hits an adapter selector **or** carries one of the module's accept phrases, minus anything the module-off baseline visit clicked by itself. Re-scoring the first run's recorded results under this rule moves no site, so the two runs below compare directly.

### Results after the fixes, 2026-10-04

Same corpus, same binary, same region, run within a few hours of the first.

| Group | Before | After |
| --- | --- | --- |
| OneTrust | 14/17 (82%) | 16/17 (94%) |
| Cookiebot | 8/11 (73%) | 9/11 (82%) |
| Usercentrics | 3/10 (30%) | 4/10 (40%) |
| Quantcast | 4/4 (100%) | 2/2 (100%) |
| Didomi | 0/0 | 0/0 |
| Static fake-CMP pages | 0/5 (0%) | 0/5 (0%) |
| **Live sites** | **29/42 (69%)** | **31/40 (78%)** |
| **Including fixtures** | **29/47 (62%)** | **31/45 (69%)** |

Four sites moved from failing to passing: `www.tillamook.com` and `www.coca-cola.com` (OneTrust), `www.poessl-group.de` (Cookiebot), `www.aufbau-verlage.de` (bespoke fallback). No site went from passing to failing; `www.drivemad.com` and `www.iphonelife.com` dropped out of the scored set because the enabled visit showed no banner at all, which the harness reports as inconclusive rather than scoring. Denominators differ between the columns for the same reason: which sites show a banner from here varies between runs.

The heavy Quantcast sites (`techradar.com`, `gamesradar.com`, `livescience.com`, `cyclingnews.com`) kill a headless browser that has already been through a hundred pages, so that group was re-run in two-site chunks with a fresh browser each time; all four showed no banner from this region anyway.

### What still fails

- **`www.seur.com` still shows a second banner.** The poll does reconsider the page, but this site's duplicate instance is not cleared within the visit.
- **Usercentrics remains the weakest adapter.** `docs.typo3.org` is now clicked and the banner goes away, but no consent cookie or storage key appears for the harness to see, so it scores as `no-consent-signal` rather than a pass. `www.landtag.sachsen.de` and `www.staerkergegenkrebs.de` accept the banner and then show a second consent surface — on the latter it is an embedded-Google-Maps consent widget, which is arguably not the cookie banner at all.
- **Single-word accept controls are still out of scope.** `www.tauck.com` ("OK"), `shopbetreiber-blog.de` ("Akzeptieren"), `thebelgian.com` ("Accept"). Adding bare "accept"/"akzeptieren" to the phrase list would widen the fallback to any pinned overlay with a one-word button, which is how a consent accepter starts dismissing paywalls. Left alone on purpose.
- **`www.commerzbank.de`** shows "Accept all" in a `cookiebox_container_root` widget that the fallback did not pick up; its container shape has not been checked.
- **The five static fixture pages still score zero**, now by a sharper rule than "adapter-only": their banners are plain static `<div>`s in normal flow, with no pinned container, so the fallback's overlay requirement rejects them. That requirement is what keeps it from clicking accept buttons on cookie-policy pages, and these pages are synthetic markup rather than a layout any real CMP ships.
