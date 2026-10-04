# Cosmetic filtering performance plan

## Goal

Cut the per-frame cost of the ad blocker's cosmetic layer without reducing coverage. The network layer needs no work: 176,177 static DNR rules across seven rulesets are matched natively, so they cost nothing at runtime beyond the shared static quota the build already manages. All of the cost is in the cosmetic path, which runs JavaScript in every frame of every page at `document_start`.

## Current cost

Measured against `content/ad-blocker-selectors.js` as generated at source revision `bde0d888ef7c5cb99e9c682b1862988e358d10d6`. That file is the flat corpus the content script used to filter; it was deleted once the last reader went away, so the figures below are history rather than something to re-measure.

| Item | Value |
| --- | --- |
| `content/ad-blocker-selectors.js` | 1,477,754 bytes, parsed and evaluated per frame (~20 ms in bare V8) |
| Entries | 20,660: 13,256 generic, 7,404 domain-scoped, 295 exceptions |
| Unique selectors | 20,186 |
| `CSS.supports()` calls per frame | 20,186, rejecting approximately none |
| `<style>` elements per frame | Up to 81, at 250 selectors each |
| Entries with a negated (`~`) domain | 0 |
| Generic (undomained) exceptions | 0 |
| Exceptions canceling a generic selector | 275, across 435 hosts |
| Generic set compiled to CSS | 192,601 bytes, 13,254 selectors |
| Domain-scoped index | 6,355 hosts, ~370 KB, median 1 selector per host, max 60 |

Three observations drive the plan. First, `update()` in `content/ad-blocker.js` recomputes a per-host selector set from the full 20,660-entry corpus in every frame, although the corpus is identical in every frame and changes only when the list is rebuilt. Second, the `CSS.supports(\`selector(${selector})\`)` guard costs 20,186 CSS parses per frame and drops close to nothing, because `build.mjs` already rejects unsupported syntax by character whitelist; a check of the shipped data found no malformed identifiers and one unquoted attribute value. Third, the data is far simpler than the runtime code assumes: no entry carries a negated domain, so the negation branch of `applies()` is dead against shipped data, and no exception is undomained, so exception handling is purely per-host.

Styles are also injected only after the `ad-blocker:get` round trip completes, so ad placements paint before they are hidden and the page reflows.

## Measured baseline

Recorded with `node tools/bench-cosmetic.mjs` on Chrome 154.0.8037.95 and macOS: the median of three navigations of `tests/fixtures/cosmetic-bench.html`, served over HTTPS as `screenrant.com` with five frames, two same-origin, one cross-origin on the same site and two cross-site. Six documents in all, each running the cosmetic content script. `--out` writes every run as JSON for the before-and-after comparison.

| Metric, summed over all six documents | No extension | Cosmetic active | Host paused |
| --- | --- | --- | --- |
| Cosmetic script evaluation | 0 ms | 21.5 ms | 22.4 ms |
| of which V8 compile | 0 ms | 13.3 ms | 13.4 ms |
| Style recalculation | 1.6 ms | 17.3 ms | 1.9 ms |
| Elements restyled | 1,913 | 1,929 | 1,913 |
| Top-document first paint | 32 ms | 68 ms | 56 ms |
| Style elements per document | 0 | 54 | 0 |
| Selectors injected per document | 0 | 13,255 | 0 |

Per frame, the filter-and-inject stage costs 2.8 ms building the selector set, 4.1 ms in 13,255 `CSS.supports()` calls, and 0.2 ms inserting 54 style elements. The paused column parses the corpus in every frame but returns before computing anything, which is what separates parse cost from filter-and-inject cost.

Four measurements correct or sharpen the assumptions above.

Parsing the corpus costs less per frame than the estimate: about 3.6 ms warm and 8.6 ms on the first navigation after the extension loads, where V8's code cache is cold, rather than ~20 ms. The parse is still worth removing, but the gain is in the aggregate across frames and in the delay before paint, not in a 20 ms per-frame figure.

The filter-and-inject stage is as expensive as the parse, about 7 ms per frame against 3.6 ms, and `CSS.supports()` alone accounts for 4.1 ms of it while rejecting exactly zero of the 13,255 selectors on this host. Phase 4 therefore carries as much of the win as phase 2, which the cost table above did not show.

Chrome attributes that stage to no trace event and no `Performance` counter, because `update()` runs in the promise callback of the `ad-blocker:get` response; only its effect on style recalculation is visible from the page. The benchmark times a replica of the current algorithm instead and asserts that the replica produces exactly the selector set the browser was seen to inject, so the number stays tied to real behavior.

First paint on the top document moves from 32 ms to 68 ms. With the host paused, so the corpus is parsed but nothing is injected, it is 56 ms. Roughly two thirds of the delay is the parse that phase 2 removes and the rest is the injection that phase 5 moves ahead of paint. Style recalculation rises more than tenfold over essentially the same element count, which confirms the cost is matching 13,255 selectors rather than touching more elements.

## Measured result

Recorded the same way as the baseline, with `node tools/bench-cosmetic.mjs` on Chrome 154.0.8037.95 and macOS, on 2026-10-04 after phase 5. The no-extension column moved between the two sittings, so the figure to read is each column's distance from its own floor, not the absolute paint numbers.

| Metric, summed over all six documents | No extension | Cosmetic active | Host paused |
| --- | --- | --- | --- |
| Cosmetic script evaluation | 0 ms | 1.0 ms | 0.9 ms |
| of which V8 compile | 0 ms | 0.3 ms | 0.2 ms |
| Style recalculation | 2.8 ms | 7.4 ms | 4.8 ms |
| Elements restyled | 1,965 | 1,929 | 1,919 |
| Top-document first paint | 36 ms | 48 ms | 36 ms |
| Style elements per document | 0 | 0 | 0 |
| Selectors adopted per frame | 0 | 275 | 0 |

Against the baseline: per-frame script evaluation over all six documents falls from 21.5 ms to 1.0 ms and its V8 compile share from 13.3 ms to 0.3 ms, because a frame now parses 19,311 bytes instead of 1,477,754. Style recalculation falls from 17.3 ms to 7.4 ms over the same element count, and first paint from 36 ms above the floor to 12 ms above it. The same 13,255 selectors apply on this host as before: 12,980 registered ahead of first paint and 275 assembled in the frame. The assembly stage, which replaced the 7 ms filter-and-inject stage, costs 0.3 ms per frame: no `CSS.supports()` call, no `<style>` element, one constructed sheet.

The paused column is no longer a floor, for the reason under "Known limits": the fixture's two cross-site frames still carry the generic stylesheet, which is most of the 2 ms it sits above the no-extension column.

## Repository fit

- `tools/ad-blocker-build/build.mjs` lines 221-248 collect cosmetic rules and write the flat array. Everything precomputed here replaces that single `writeFile`. Cosmetic scope stays EasyList-only; this plan changes the output format, not what is selected.
- `modules/ad-blocker.js` already answers `ad-blocker:get` from the service worker with the resolved top-frame hostname. The per-host selector lookup belongs in that existing response, not in a new message.
- `content/ad-blocker.js` keeps its own setting listener and teardown, as `plans/ad-blocker.md` requires; it loses the corpus filtering, not the lifecycle.
- `manifest.json` holds `scripting` and `<all_urls>`, so the generic stylesheet can be registered dynamically rather than declared, which is what allows it to honor the pause list.
- `tools/check-ad-blocker-live.mjs` already drives headless Chrome over CDP. Both the build-time selector validation and the benchmark reuse that pattern; note that a global `WebSocket` needs the Node 22 the build already requires.

## Implementation

1. **Benchmark before changing anything.** Done: `tools/bench-cosmetic.mjs` and `tests/fixtures/cosmetic-bench.html`, with the numbers under "Measured baseline" above. It serves the fixture over HTTPS under the real hostnames it is written against, because Chrome's HSTS preload list refuses plain HTTP for them, and reads each document through its own execution context, so the frame count does not depend on how Chrome distributed frames over processes. It asserts the structural facts behind the numbers, a generic hide, a host-scoped hide, a generic selector the host excepts, and nothing injected when the host is paused, so a baseline that silently measured a no-op fails instead of being recorded.
2. **Precompute the corpus at build time.** Done: `tools/ad-blocker-build/cosmetic.mjs`, with `tools/ad-blocker-build/chrome.mjs` for the headless session, called from `build.mjs` and runnable on its own so the cosmetic artifacts can be regenerated without refetching the network lists. `content/ad-blocker-generic.css` holds the 12,980 generic selectors that no exception touches, as one `display: none !important` rule, 189,506 bytes, with the cookie and consent exclusion applied at build time: 6 selectors, 2 of them generic. `content/ad-blocker-excepted.js` holds the 275 exception rules that cancel one of 274 generic selectors, 16,006 bytes, one entry per EasyList rule rather than a merged domain list per selector, so the content script evaluates exactly the rules upstream wrote. `content/ad-blocker-domain-rules.js` holds the domain-scoped corpus as a host-to-entries map, 6,343 hosts over 11,418 hide values and 513 exception values, 357,084 bytes, as an ES module for the service worker. Negated domains are carried as `[selector, ...excluded hosts]`, and an exception scoped only by negation would go to a `globalExceptions` list; the shipped data populates neither.

   Chrome's CSS parser accepted all 20,163 distinct selectors, which confirms the per-frame `CSS.supports()` guard rejects nothing, and the generated stylesheet is parsed back and asserted to be one rule over 12,980 selectors with `display: none !important` intact. The build also checks the artifacts against the unsplit corpus on every host an exception names, a sample of the domain-scoped hosts, a `www.deep.` subdomain of each, and a host no rule mentions, and fails if the resolved selector set differs; the host list comes from the parsed corpus rather than from the artifacts, so an artifact that loses a host cannot also lose the check for it. Four deliberate mutations of the split, including one that leaves a cancelled selector in the static stylesheet, are each caught. `rules/build-report.json` records the file sizes, counts, and everything dropped: 6 consent selectors, 0 invalid, 0 cancelled everywhere, and 17 exceptions that cancel nothing left in the corpus. The flat array is still written for the content script that has not moved yet; phases 4 and 5 take its last reader away.
3. **Resolve domain rules in the service worker.** Done: `resolveCosmetic()` in `modules/ad-blocker.js` walks a host's label suffixes, so `a.b.example.com` costs four map lookups, subtracts the exceptions those same suffixes carry, and returns the result on the existing `ad-blocker:get` response. A disabled module, a paused host, and a sender that names no tab, which is how the popup asks, all resolve to nothing, so the map is never consulted for them. Negated-domain handling stays in this path, both in the index values and in the `globalExceptions` list, even though the shipped data populates neither.

   The map is a static import rather than a lazy one: `import()` is disallowed on `ServiceWorkerGlobalScope` by the HTML specification, which Chrome 154 enforces, so there is no way to defer the 357 KB to the first frame that asks. It is therefore parsed on every worker wake, which costs about 3 ms: the median cold `ad-blocker:get` round trip, measured over seven worker restarts each, is 8.3-10.2 ms with the map against 5.5-5.9 ms with it stubbed out, and the warm round trip is 0.5 ms either way. One wake serves every frame of every page for as long as the worker lives, against 3.6 ms in every frame before, so phase 7 is not warranted; the numbers are in that entry.

   Two corrections to the shape of the data. Only 2 of the 513 exception values in the index cancel a domain-scoped hide the same host resolves; the other 511 cancel a generic selector, which is what `content/ad-blocker-excepted.js` carries, so the subtraction that matters most here happens in phase 4. And the content script still computes its own set from the flat corpus, so the new field is unread until phase 4 takes it.
4. **Reduce the content script to assembly.** Done: a frame now loads 19,311 bytes, `content/ad-blocker-excepted.js` beside a 3,305-byte `content/ad-blocker.js`, rather than parsing the 1,477,754-byte corpus. Per frame it evaluates the 275 exception rules against the top-frame host, which is the one cosmetic decision that still needs the host, unions what survives with the selectors the `ad-blocker:get` response already resolved, and adopts a single constructed `CSSStyleSheet`. No `CSS.supports()` call, no corpus filtering, no `<style>` element. The subtraction runs over the union rather than over the excepted list alone, because an exception cancels its selector whichever list offered it; that is the rule `verify()` in `tools/ad-blocker-build/cosmetic.mjs` already holds the artifacts to.

   A setting change swaps the sheet. Going inactive detaches it at once, since the sheet is already there, but coming back has to ask the service worker again: a paused or disabled host is answered with no selectors, so there is nothing cached to put back.

   A stylesheet constructed in the content script's isolated world does style the page it is adopted into. `tools/check-ad-blocker-live.mjs` asserts that against the loaded extension rather than assuming it, on `#ad-carousel`, a generic selector that one host cancels and `127.0.0.1` does not, across pause, global toggle, and a resume. `tests/ad-blocker.test.cjs` covers the assembly itself in a realm with no `CSS` global, so a reintroduced `CSS.supports()` call would throw, and checks that no consent selector reached any shipped artifact, which is the guarantee the per-frame consent filter used to carry.

   Generic hiding is absent between this phase and the next: `#AdBox2` in `tests/fixtures/ad-blocker.html` stays visible until phase 5 registers `content/ad-blocker-generic.css`, and the live check's assertions on it return there. `tools/bench-cosmetic.mjs` is likewise left measuring the old algorithm against the flat corpus, which it is now the only reader of; the after run belongs with phase 5, when the mechanism is whole.
5. **Register the generic stylesheet dynamically.** Done: the cosmetic entry has left `manifest.json` for `cosmeticScripts()` and `reconcileCosmetic()` in `modules/ad-blocker.js`, which `reconcile()` now covers alongside ruleset and dynamic-rule state. A registration persists across browser sessions and survives an extension update, so one left from an earlier preference is replaced and one already correct is left alone, or every worker wake would unregister and re-register in every tab's way.

   The layer is registered in two parts rather than one, because only one half can be switched off from inside a frame. The per-host script stays registered while the module is off, so a frame already open adopts its own sheet again the moment the setting returns. Content-script CSS has no such handle, as Chrome gives a frame no way to detach what it injected for it, so `content/ad-blocker-generic.css` is registered only while the module is on, with `excludeMatches` derived from `adBlockerPausedSites`. A registered stylesheet applies from the next navigation, so the popup now asks for a reload when the setting or the pause list changes.

   Registering the sheet made a bug visible that phase 2 had shipped: of the 12,980 generic selectors grouped into one rule, only the first 8,137 ever matched. Blink indexes a rule's selectors with a 13-bit field counting `CSSSelector` entries rather than list positions, so a selector starting past entry 8191 of its rule is parsed, kept, reported by `selectorText`, and never matched. Phase 2's validation could not see it, because it only asked the parser, and the sheet did parse as one rule over all 12,980 selectors. The stylesheet is now 13 rules of at most 1,000 selectors, and `tools/ad-blocker-build/cosmetic.mjs` checks the artifact by matching: every selector that can be handed an element gets one, 12,823 of the 12,980, and the sheet has to hide it. The remainder are combinators and attribute values too structural to synthesize an element for, and the rule size covers those.
6. **Update the tests.** Done: `tests/ad-blocker.test.cjs` asserts the manifest declares no ad-blocker content script, checks the registration `cosmeticScripts()` produces for each of on, off and paused, including the bare match pattern an IP literal gets, and drives `reconcile()` against a `chrome.scripting` stub seeded with a stale persisted registration, so a registration that survived a restart with the wrong shape is replaced rather than counted as correct. The stylesheet gets a parse check: a banner comment and then one `display:none` rule per line, each grouping at most 1,000 selectors, with balanced brackets and quotes in every selector.

   `tools/check-ad-blocker-live.mjs` waits for the registration before opening any page, since a page opened before the worker has run carries no cosmetic filtering at all, and reads `#AdBox2` from an inline script in the fixture while the parser is still inside `<body>` and `performance.getEntriesByType('paint')` is still empty. That is what makes "ahead of first paint" a measurement rather than an inference; `#ad-carousel`, which the frame assembles after its round trip, is still visible at that same reading. Pause, global toggle and a worker restart are each read on the page that was already open and on a page opened afterwards, because a registered stylesheet changes with the next navigation.
7. **Shard the host map only if measured.** Not needed: the wake cost measured in phase 3 is about 3 ms, paid once per worker wake rather than once per frame, and a lazy per-lookup shard is impossible anyway because a service worker may not `import()`. Sharding would mean a format that can be fetched instead, which is only worth doing if this number grows.

## Verification and acceptance

- Per-frame JavaScript drops from 1,477,754 bytes to roughly 20 KB, `CSS.supports` calls per frame from 20,186 to zero, and injected style elements from up to 81 to none: one registered pre-paint stylesheet and one constructed sheet, neither of which is a `<style>` element. Confirmed at 19,311 bytes and zero of each.
- The benchmark from phase 1 shows the improvement, run on the same fixture before and after.
- Generic hiding is in effect at first paint, confirmed in the live check rather than inferred.
- The selector set applied on a given host is identical to the set the current code computes, checked on a generic-only host, a domain-scoped host, and a host that cancels a generic selector.
- Global toggle, site pause, browser restart, extension reload or update, and backup/restore still leave storage, popup, network rules, and cosmetic filtering in agreement.
- No cookie-banner or consent selector enters the generic stylesheet, so the build-time exclusion matches today's runtime exclusion.

## Known limits

Pausing a site no longer covers every frame on it. `excludeMatches` is matched against each frame's own URL rather than the top frame's, so a cross-site frame embedded in a paused page still receives the generic stylesheet; the per-host half does go quiet everywhere, because the service worker decides from the top frame's host. The alternative is to inject the sheet per tab after a navigation commits, which gives back the pre-paint guarantee this phase exists to provide. Before phase 4 the per-frame filter read the top host and so covered embedded frames, which makes this a narrowing: a visitor who pauses a site because filtering broke an embedded payment or video frame will not get that frame back.

Around 13,000 generic selectors still live in the style engine and participate in every style recalculation. That is inherent to the filter list, and the browser's indexing on the rightmost compound keeps it tractable; trimming it would mean cutting coverage, which is a separate decision from this plan. Grouping all generic selectors into a single CSS rule also means the build-time validation must be exact, because one invalid selector would silently drop the whole rule rather than just itself; phases 2 and 6 cover that with in-browser validation and a parse check.
