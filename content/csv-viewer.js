// Chrome's plain-text viewer drops a CSV into a single <pre>, where the columns only line
// up if every value happens to be the same width. This swaps that <pre> for a table and
// keeps it aside, so "Raw text" always gets the original file back.
productivityModules.register("csv-viewer", () => {
  // Chrome labels its text viewer text/plain; the other two arrive when a server labels a
  // file honestly and the module's network rule has relabeled it for rendering.
  const TYPES = ["text/plain", "text/csv", "text/tab-separated-values"];
  // Past this, parsing costs more than a table is worth and the file belongs in a download.
  const MAX_BYTES = 30 * 1024 * 1024;
  // A table this tall already outruns scrolling; the count line says what is held back.
  const MAX_ROWS = 20000;
  const DELIMITER_NAMES = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" };
  const SHEET = `
.pcsv-host {
  --pcsv-bg: #ffffff;
  --pcsv-fg: #1f2328;
  --pcsv-muted: #656d76;
  --pcsv-line: #e2e5e9;
  --pcsv-head: #f3f5f7;
  --pcsv-zebra: #fafbfc;
  --pcsv-accent: #0b69d4;
  margin: 0;
  background: var(--pcsv-bg);
  color: var(--pcsv-fg);
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .pcsv-host {
    --pcsv-bg: #16181b;
    --pcsv-fg: #e6e8ea;
    --pcsv-muted: #9aa3ad;
    --pcsv-line: #2c3034;
    --pcsv-head: #212428;
    --pcsv-zebra: #1b1e21;
    --pcsv-accent: #6cb0ff;
  }
}
.pcsv-host .pcsv-bar {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  background: var(--pcsv-bg);
  border-bottom: 1px solid var(--pcsv-line);
}
.pcsv-host .pcsv-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 24rem;
}
.pcsv-host .pcsv-filter {
  flex: 0 1 18rem;
  min-width: 8rem;
  padding: 4px 8px;
  font: inherit;
  color: inherit;
  background: var(--pcsv-bg);
  border: 1px solid var(--pcsv-line);
  border-radius: 6px;
}
.pcsv-host .pcsv-filter:focus-visible {
  outline: 2px solid var(--pcsv-accent);
  outline-offset: -1px;
}
.pcsv-host .pcsv-count {
  color: var(--pcsv-muted);
  margin-right: auto;
  white-space: nowrap;
}
.pcsv-host .pcsv-toggle {
  padding: 4px 10px;
  font: inherit;
  color: inherit;
  background: var(--pcsv-head);
  border: 1px solid var(--pcsv-line);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.pcsv-host .pcsv-scroll {
  /* A scrollbar that appears as a filter shortens the table must not shift the columns
     out from under the pointer, so its space is reserved up front. */
  scrollbar-gutter: stable;
  overflow: auto;
  max-height: calc(100vh - 41px);
}
.pcsv-host .pcsv-table {
  border-collapse: separate;
  border-spacing: 0;
  /* Narrow columns keep their own width instead of being stretched to fill the viewport. */
  width: auto;
}
.pcsv-host .pcsv-table th,
.pcsv-host .pcsv-table td {
  padding: 4px 10px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--pcsv-line);
  border-right: 1px solid var(--pcsv-line);
  /* Long values wrap rather than being clipped: a truncated cell is a wrong cell. But
     only at a break the value already has: 'anywhere' would put a cell's min-content
     width at one character, and the auto table layout then squeezes a 10-digit id into
     three stacked lines. 'break-word' leaves the intrinsic width alone, so a column is
     as wide as its longest value until it hits the cap below. */
  max-width: 32rem;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.pcsv-host .pcsv-table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--pcsv-head);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.pcsv-host .pcsv-table thead th:hover { color: var(--pcsv-accent); }
.pcsv-host .pcsv-arrow {
  display: inline-block;
  width: 1em;
  color: var(--pcsv-accent);
}
.pcsv-host .pcsv-table .pcsv-line,
.pcsv-host .pcsv-table .pcsv-corner {
  position: sticky;
  left: 0;
  background: var(--pcsv-head);
  color: var(--pcsv-muted);
  font-weight: 400;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.pcsv-host .pcsv-table .pcsv-corner {
  z-index: 3;
  cursor: default;
}
.pcsv-host .pcsv-table .pcsv-corner:hover { color: var(--pcsv-muted); }
.pcsv-host .pcsv-table .pcsv-line { z-index: 1; }
.pcsv-host tbody tr:nth-child(even) td { background: var(--pcsv-zebra); }
.pcsv-host tbody tr:hover td { background: color-mix(in srgb, var(--pcsv-accent) 10%, transparent); }
/* Outranking the th/td default above needs a third class, not just a later rule. */
.pcsv-host .pcsv-table .pcsv-number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pcsv-host.pcsv-reading-raw > pre {
  margin: 0;
  padding: 10px 12px;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
`;

  if (!TYPES.includes(document.contentType)) return;
  // A name ending in .csv or .tsv is a promise, and the file is taken at its word. Anything
  // else — AmesHousing.txt, an export with no extension — has to earn it on shape alone.
  const named = /\.(?:csv|tsv)(?:$|[?#])/i.test(location.pathname + location.search);

  let active = true;
  let restore;
  const open = () => { if (active && !restore) restore = show(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", open, { once: true });
  else open();
  return () => {
    active = false;
    document.removeEventListener("DOMContentLoaded", open);
    restore?.();
    restore = undefined;
  };

  function show() {
    const source = document.querySelector("body > pre");
    const text = source?.textContent ?? "";
    if (!text.trim() || text.length > MAX_BYTES) return;
    // Judged on the first 64 KB, so an unnamed file that is not a table costs a sample
    // rather than a full parse. Only then is the whole thing read, with the delimiter the
    // survey already settled on.
    const survey = csvTable.survey(text);
    if (!named && !csvTable.looksTabular(survey)) return;
    const table = csvTable.read(text, survey.delimiter);
    // One column is a list, not a sheet, and the <pre> already shows it perfectly well.
    if (table.columns < 2 || !table.rows.length) return;

    const sorter = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const bodyClass = document.body.className;
    let sortColumn = -1;
    let descending = false;
    let query = "";
    let frame = 0;

    const style = element("style");
    style.id = "productivity-csv-viewer";
    style.textContent = SHEET;

    const name = element("strong", "pcsv-name");
    name.textContent = decodeURIComponent(location.pathname.split("/").pop() || "CSV");
    const filter = element("input", "pcsv-filter");
    filter.type = "search";
    filter.placeholder = "Filter rows";
    filter.setAttribute("aria-label", "Filter rows");
    const count = element("span", "pcsv-count");
    count.setAttribute("role", "status");
    const raw = element("button", "pcsv-toggle");
    raw.type = "button";
    raw.textContent = "Raw text";
    const bar = element("div", "pcsv-bar");
    bar.append(name, filter, count, raw);

    const headRow = element("tr");
    headRow.append(corner(), ...headerCells());
    const head = element("thead");
    head.append(headRow);
    const body = element("tbody");
    const sheet = element("table", "pcsv-table");
    sheet.append(head, body);
    // The toolbar stays put while this one element swaps with the original <pre>.
    const scroll = element("div", "pcsv-scroll");
    scroll.append(sheet);

    // Every row keeps the line it came from, so sorting and filtering never cost you the
    // ability to find a value back in the file.
    const numbered = table.rows.map((row, index) => ({ row, line: index + 1 }));
    render();

    source.remove();
    document.body.replaceChildren(style, bar, scroll);
    document.body.className = "pcsv-host";

    filter.addEventListener("input", () => {
      query = filter.value.trim().toLowerCase();
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; render(); });
    });
    raw.addEventListener("click", () => {
      const showingTable = scroll.isConnected;
      if (showingTable) scroll.replaceWith(source);
      else source.replaceWith(scroll);
      raw.textContent = showingTable ? "Table" : "Raw text";
      filter.disabled = showingTable;
      document.body.classList.toggle("pcsv-reading-raw", showingTable);
    });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.replaceChildren(source);
      document.body.className = bodyClass;
    };

    function element(tag, className) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      return node;
    }

    function corner() {
      const cell = element("th", "pcsv-corner");
      cell.scope = "col";
      cell.textContent = "#";
      return cell;
    }

    function headerCells() {
      return Array.from({ length: table.columns }, (_, column) => {
        const cell = element("th", table.numeric[column] ? "pcsv-number" : null);
        cell.scope = "col";
        cell.setAttribute("aria-sort", "none");
        const label = element("span", "pcsv-label");
        label.textContent = table.header?.[column]?.trim() || columnName(column);
        const arrow = element("span", "pcsv-arrow");
        cell.append(label, arrow);
        cell.addEventListener("click", () => sortBy(column, cell));
        return cell;
      });
    }

    // A headerless file still needs something to click on, so its columns get spreadsheet
    // letters: A, B, … Z, AA.
    function columnName(column) {
      let label = "";
      for (let index = column; index >= 0; index = Math.floor(index / 26) - 1) {
        label = String.fromCharCode(65 + (index % 26)) + label;
      }
      return label;
    }

    // Ascending, descending, then back to file order: a sort you can undo without reloading.
    function sortBy(column, cell) {
      if (sortColumn !== column) { sortColumn = column; descending = false; }
      else if (!descending) descending = true;
      else { sortColumn = -1; descending = false; }
      for (const other of headRow.children) {
        other.setAttribute("aria-sort", "none");
        other.querySelector(".pcsv-arrow")?.replaceChildren();
      }
      if (sortColumn === column) {
        cell.setAttribute("aria-sort", descending ? "descending" : "ascending");
        cell.querySelector(".pcsv-arrow").textContent = descending ? "▾" : "▴";
      }
      render();
    }

    function matches(entry) {
      if (!query) return true;
      // Space-separated terms all have to appear somewhere in the row, which is how you
      // narrow to one record without knowing which column holds what.
      const haystack = entry.row.join(" ").toLowerCase();
      return query.split(/\s+/).every(term => haystack.includes(term));
    }

    function render() {
      const visible = numbered.filter(matches);
      // Original line as the tiebreak keeps equal rows in file order, so a sort on one
      // column does not scramble the rows it cannot tell apart.
      if (sortColumn >= 0) visible.sort((left, right) => compare(left, right) || left.line - right.line);
      const shown = visible.slice(0, MAX_ROWS);
      const fragment = document.createDocumentFragment();
      for (const entry of shown) fragment.append(rowFor(entry));
      body.replaceChildren(fragment);
      count.textContent = summary(visible.length, shown.length);
    }

    function compare(left, right) {
      const first = left.row[sortColumn] ?? "";
      const second = right.row[sortColumn] ?? "";
      const blankFirst = first.trim() === "";
      const blankSecond = second.trim() === "";
      // Blanks sort last whichever way round. Reversing them along with the values would
      // put a column's empty cells in front of the data the moment you sorted descending.
      if (blankFirst || blankSecond) return blankFirst === blankSecond ? 0 : blankFirst ? 1 : -1;
      const order = table.numeric[sortColumn]
        ? csvTable.numberOf(first) - csvTable.numberOf(second)
        : sorter.compare(first, second);
      return descending ? -order : order;
    }

    function rowFor(entry) {
      const tr = element("tr");
      const line = element("th", "pcsv-line");
      line.scope = "row";
      line.textContent = entry.line;
      tr.append(line);
      for (let column = 0; column < table.columns; column++) {
        const cell = element("td", table.numeric[column] ? "pcsv-number" : null);
        cell.textContent = entry.row[column] ?? "";
        tr.append(cell);
      }
      return tr;
    }

    function summary(total, shown) {
      const rows = total === numbered.length
        ? `${numbered.length.toLocaleString()} rows`
        : `${total.toLocaleString()} of ${numbered.length.toLocaleString()} rows`;
      const held = shown < total ? ` · showing first ${shown.toLocaleString()}` : "";
      const delimiter = DELIMITER_NAMES[table.delimiter] || table.delimiter;
      return `${rows} · ${table.columns} columns · ${delimiter}-separated${held}`;
    }
  }
});
