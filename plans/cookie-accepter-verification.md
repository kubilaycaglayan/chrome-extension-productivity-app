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
