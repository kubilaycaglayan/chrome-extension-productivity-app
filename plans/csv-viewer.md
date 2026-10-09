# CSV viewer

Show a `.csv` or `.tsv` link as a table of columns instead of downloading it.

## The constraint that shapes the module

A content script cannot reach a CSV, because there is no page to reach. Chrome decides what
to do with a response from its `Content-Type`, and `text/csv` is not a type it renders: the
response goes to the downloader and the navigation aborts. Measured over CDP before any of
this was written:

| served as | what Chrome does |
| --- | --- |
| `text/csv` | `net::ERR_ABORTED` — downloaded, no document, no content script |
| `text/plain` | rendered inside a single `<pre>` |
| `file:///…​.csv` | downloaded, same as `text/csv` (and would need file access besides) |

So the module is in two halves, and the first one is a network rule.

## The two halves

**`modules/csv-viewer.js`** writes one dynamic declarativeNetRequest rule: on a `main_frame`
request whose URL carries `.csv` or `.tsv`, set `content-type` to `text/plain; charset=utf-8`
and remove `content-disposition`. Both are needed — an attachment disposition downloads the
file whatever its type says. The rule is dynamic rather than static so it costs nothing
against the static ruleset quota and survives a sleeping service worker. Its priority sits
above 1000000 because the ad blocker writes `allowAllRequests` rules at that priority for
every site it is paused on, and an allow rule cancels a header rule beneath it.

**`content/csv-viewer.js`** then finds the `<pre>` Chrome rendered, parses it with
`shared/csv-table.js`, and replaces it with a table: sticky header, sticky row numbers,
right-aligned numeric columns, click-to-sort, and a filter box. The original `<pre>` is kept
out of the tree rather than rebuilt, so the raw text is the file byte for byte.

## Three panels under one toolbar

The toolbar is fixed and the single element beneath it swaps: the table, the original
`<pre>`, or the per-column stats. Each of the two buttons is a round trip to its own panel
and back, so "Stats" reads "Table" while the stats are up and "Raw text" still goes
straight to the text from there. The filter stays live in the stats panel and is disabled
only for the raw text, which is one unsplit string with no rows to narrow.

A stats card per column carries the count of distinct values, those values listed
commonest first with how many rows hold each, and how many of the column's cells are
empty — the question a file answers before any of its numbers mean anything.

A card whose list runs past ten values arrives folded, with a button saying how many more
it would draw. The panel's whole purpose is that a file's columns can be compared side by
side, and one column of sixty values pushes the rest of them off the screen. Only the
visible rows are built, so a wide file folded shut is ten list items a card rather than
fifty, and the rest are never made until they are asked for.

## Named files, and files judged on shape

A name ending in `.csv` or `.tsv` is a promise, and the file is taken at its word: whatever
parses gets a table. Plenty of real data does not carry that name, though —
`jse.amstat.org/v19n3/decock/AmesHousing.txt` is 2930 rows of tab-separated housing data
served as `text/plain`, and a rule about file extensions would never see it.

So any other text document has to earn the table on shape alone. `csvTable.survey` reads the
first 64 KB, picks the delimiter, and reports how many lines agree on a column count;
`looksTabular` requires at least three lines, more than one column, and 95% agreement. Prose
fails on the last count, because the one sentence that happens to hold a comma is alone in
doing so; a log with no delimiter never gets past one column. Judging from the sample means
an unnamed 30 MB file that is not a table costs a 64 KB read rather than a full parse.

## Decisions worth remembering

- **The delimiter is scored, not assumed.** Comma, semicolon, tab and pipe are each tried;
  the one that makes the file most rectangular wins, with column count as the tiebreak. A
  semicolon file whose notes contain commas therefore still reads as semicolons.
- **A first row of numbers above more numbers is data.** Promoting it to a heading would
  hide a record, so a headerless file gets spreadsheet letters (A, B, C) instead.
- **A number is only what a spreadsheet writes back out.** `1,234` and `-9.99` are numbers;
  `1.234,56` is not, because a decimal comma cannot be told from a thousands comma without
  knowing the file's locale, and guessing wrong silently reorders a sort. ISO dates stay
  text, which is also how they sort correctly.
- **One non-number keeps a column text.** A single `n/a` is enough; blanks do not count.
- **Blanks sort last in both directions.** Reversing them with the values would put a
  column's empty cells in front of the data the moment you sorted descending.
- **Rows carry the line they came from**, so a sorted or filtered value can still be found
  back in the file.
- **The stats count the rows the filter left**, not the file. Numbers that kept answering
  for all 20000 rows while the table above showed twelve would be read as describing those
  twelve; the note at the top of the panel says which set it is.
- **A blank cell is the only null.** Whitespace-only counts as blank, and a row too short
  to reach a column has no cell there, which is the same absence. A spelled-out `NA`,
  `null` or `-` is a value the file chose to write, so it stays a value and appears in the
  list, where it can be seen for what it is rather than silently folded into a null count.
- **Distinct means distinct as written.** ` apple` and `apple` are two values, because the
  stray space is a real fact about the file and hiding it would be the wrong answer.

## Known trade-offs

- While the module is on, a CSV link opens instead of downloading. That is the point, and
  the module switch in the popup is the way back. "Raw text" then Save also works.
- The response is relabeled `charset=utf-8`. A CSV in a legacy single-byte encoding will
  show mojibake; "Raw text" shows the same bytes Chrome decoded, so the fix is to download
  it with the module off.
- A CSV served as `text/csv` from a URL that does not name the file is untouched — the rule
  matches on the URL, and the headers that would identify it have not arrived when the rule
  is applied. Once a file renders as text, though, shape takes over from the name.
- The 95% agreement bar is a judgement call. A text file that is genuinely a two-column
  table will be rendered as one; "Raw text" is one click away when that is not wanted.
- The table renders at most 20000 rows; the count line says so when it holds rows back.
- A stats card draws at most 50 values and folds past 10. An id column has as many distinct
  values as it has rows, and listing them is a second copy of the file; the distinct count
  above the list is the part that was asked for. The 50 is only mentioned once the card is
  unfolded — "+ 10 more values" under a list that is itself folded shut says nothing a
  reader can act on.
- Which cards the user unfolded is held outside them, because every card is rebuilt from
  scratch on each keystroke in the filter, and a card that folded itself back up under the
  hand that opened it would be its own bug. A card narrowed below 10 values loses the
  button rather than keeping one that offers nothing.

## Checks

- `node --test tests/` — parser, viewer DOM, the stats panel, and the rule's shape and
  lifecycle.
- `node tools/check-csv-viewer-live.mjs` — needs Node 22+ for global `WebSocket`. Loads the
  extension into a real Chrome, serves a CSV as `text/csv` with an attachment disposition,
  and asserts a sortable table comes back; serves the same data as `.txt` and asserts shape
  alone is enough; serves prose as `.txt` and asserts it is left as text; serves a
  twelve-value column and drives the fold, which is the only place that control sits in a
  real grid — that unfolding makes the card taller is measured there rather than inferred
  from the DOM it left behind; then switches the module off and asserts the link aborts
  into a download again. This is the only check that can prove the header rule works at all.
