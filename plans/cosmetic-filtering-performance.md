# Cosmetic filtering performance plan

## Goal

Cut the per-frame cost of the ad blocker's cosmetic layer without reducing coverage. The network layer needs no work: 176,177 static DNR rules across seven rulesets are matched natively, so they cost nothing at runtime beyond the shared static quota the build already manages. All of the cost is in the cosmetic path, which runs JavaScript in every frame of every page at `document_start`.

## Current cost

Measured against `content/ad-blocker-selectors.js` as generated at source revision `bde0d888ef7c5cb99e9c682b1862988e358d10d6`.

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
5. **Register the generic stylesheet dynamically.** Move the cosmetic entry out of the static `content_scripts` block into `chrome.scripting.registerContentScripts`, with `css: ['content/ad-blocker-generic.css']`, `runAt: 'document_start'`, `allFrames: true`, and `excludeMatches` derived from `adBlockerPausedSites`. Extend `reconcile()` to cover registration state the way it already covers ruleset and dynamic-rule state, including the case where a persisted registration survives a restart. This is what moves generic hiding ahead of first paint and removes the current flash and reflow.
6. **Update the tests.** `tests/ad-blocker.test.cjs` asserts the cosmetic content script entry runs in all frames; that stays true, but the file list changes and the registration now comes from `modules/ad-blocker.js`. Add coverage for the suffix-walk lookup, for exception subtraction on a host that cancels a generic selector, and a parse check that the generic stylesheet is one valid rule. Extend `tools/check-ad-blocker-live.mjs` to confirm a generic hide and an excepted host still behave correctly end to end.
7. **Shard the host map only if measured.** Not needed: the wake cost measured in phase 3 is about 3 ms, paid once per worker wake rather than once per frame, and a lazy per-lookup shard is impossible anyway because a service worker may not `import()`. Sharding would mean a format that can be fetched instead, which is only worth doing if this number grows.

## Verification and acceptance

- Per-frame JavaScript drops from 1,477,754 bytes to roughly 20 KB, `CSS.supports` calls per frame from 20,186 to zero, and injected style elements from up to 81 to one pre-paint sheet plus at most one small sheet.
- The benchmark from phase 1 shows the improvement, run on the same fixture before and after.
- Generic hiding is in effect at first paint, confirmed in the live check rather than inferred.
- The selector set applied on a given host is identical to the set the current code computes, checked on a generic-only host, a domain-scoped host, and a host that cancels a generic selector.
- Global toggle, site pause, browser restart, extension reload or update, and backup/restore still leave storage, popup, network rules, and cosmetic filtering in agreement.
- No cookie-banner or consent selector enters the generic stylesheet, so the build-time exclusion matches today's runtime exclusion.

## Known limits

Around 13,000 generic selectors still live in the style engine and participate in every style recalculation. That is inherent to the filter list, and the browser's indexing on the rightmost compound keeps it tractable; trimming it would mean cutting coverage, which is a separate decision from this plan. Grouping all generic selectors into a single CSS rule also means the build-time validation must be exact, because one invalid selector would silently drop the whole rule rather than just itself; phases 2 and 6 cover that with in-browser validation and a parse check.
