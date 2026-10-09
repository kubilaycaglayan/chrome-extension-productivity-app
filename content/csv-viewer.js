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
  // An id column has as many distinct values as it has rows, and listing them is a second
  // copy of the file. The count above the list is the part that was worth asking for, so
  // the list itself stops here and says how many it did not draw.
  const MAX_VALUES = 50;
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
.pcsv-host .pcsv-stats {
  scrollbar-gutter: stable;
  overflow: auto;
  max-height: calc(100vh - 41px);
  padding: 12px;
}
.pcsv-host .pcsv-stats-note {
  margin: 0 0 10px;
  color: var(--pcsv-muted);
}
.pcsv-host .pcsv-stats-grid {
  display: grid;
  /* As many cards as fit, one per column of the file. A card is read top to bottom, so
     they align at their tops rather than stretching to the tallest in the row. */
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 12px;
  align-items: start;
}
.pcsv-host .pcsv-stat {
  border: 1px solid var(--pcsv-line);
  border-radius: 8px;
  overflow: hidden;
}
.pcsv-host .pcsv-stat-head {
  padding: 6px 10px;
  background: var(--pcsv-head);
}
.pcsv-host .pcsv-stat-name {
  margin: 0;
  font-size: inherit;
  font-weight: 600;
  overflow-wrap: break-word;
}
.pcsv-host .pcsv-stat-meta {
  margin: 1px 0 0;
  color: var(--pcsv-muted);
}
.pcsv-host .pcsv-stat-values {
  margin: 0;
  padding: 0;
  list-style: none;
}
.pcsv-host .pcsv-stat-values li,
.pcsv-host .pcsv-stat-more {
  display: flex;
  gap: 10px;
  align-items: baseline;
  justify-content: space-between;
  margin: 0;
  padding: 3px 10px;
  border-top: 1px solid var(--pcsv-line);
}
/* A value can be long; the count beside it must not be pushed out of the card. */
.pcsv-host .pcsv-stat-text {
  min-width: 0;
  overflow-wrap: break-word;
}
.pcsv-host .pcsv-stat-count {
  color: var(--pcsv-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.pcsv-host .pcsv-stat-more { color: var(--pcsv-muted); }
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
    const stats = element("button", "pcsv-toggle");
    stats.type = "button";
    stats.textContent = "Stats";
    const raw = element("button", "pcsv-toggle");
    raw.type = "button";
    raw.textContent = "Raw text";
    const bar = element("div", "pcsv-bar");
    bar.append(name, filter, count, stats, raw);

    const headRow = element("tr");
    headRow.append(corner(), ...headerCells());
    const head = element("thead");
    head.append(headRow);
    const body = element("tbody");
    const sheet = element("table", "pcsv-table");
    sheet.append(head, body);
    // The toolbar stays put while the one element beneath it swaps for another.
    const scroll = element("div", "pcsv-scroll");
    scroll.append(sheet);
    const statsNote = element("p", "pcsv-stats-note");
    statsNote.setAttribute("role", "status");
    const statsGrid = element("div", "pcsv-stats-grid");
    const statsPanel = element("div", "pcsv-stats");
    statsPanel.append(statsNote, statsGrid);

    // Every row keeps the line it came from, so sorting and filtering never cost you the
    // ability to find a value back in the file.
    const numbered = table.rows.map((row, index) => ({ row, line: index + 1 }));
    // What the filter left, shared by the table and the stats so the two can never
    // disagree about which rows they are describing.
    let visible = [];
    // The table, the original file, and the per-column stats, one of which occupies the
    // slot under the toolbar. Each button is a round trip to its own panel and back.
    const panels = { table: scroll, raw: source, stats: statsPanel };
    let panel = "table";
    render();

    source.remove();
    document.body.replaceChildren(style, bar, scroll);
    document.body.className = "pcsv-host";

    filter.addEventListener("input", () => {
      query = filter.value.trim().toLowerCase();
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; render(); });
    });
    stats.addEventListener("click", () => display("stats"));
    raw.addEventListener("click", () => display("raw"));

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
      visible = numbered.filter(matches);
      // Original line as the tiebreak keeps equal rows in file order, so a sort on one
      // column does not scramble the rows it cannot tell apart.
      if (sortColumn >= 0) visible.sort((left, right) => compare(left, right) || left.line - right.line);
      const shown = visible.slice(0, MAX_ROWS);
      const fragment = document.createDocumentFragment();
      for (const entry of shown) fragment.append(rowFor(entry));
      body.replaceChildren(fragment);
      count.textContent = summary(visible.length, shown.length);
      // Retyping in the filter while the stats are up has to move the numbers, or they
      // would silently describe the rows from before the keystroke.
      if (panel === "stats") renderStats();
    }

    // A second press on the button that opened a panel is how you get back to the table,
    // so a panel asked for while it is already up means the table.
    function display(next) {
      const target = next === panel ? "table" : next;
      if (target === panel) return;
      if (target === "stats") renderStats();
      panels[panel].replaceWith(panels[target]);
      panel = target;
      stats.textContent = panel === "stats" ? "Table" : "Stats";
      raw.textContent = panel === "raw" ? "Table" : "Raw text";
      // The filter still chooses the rows the stats are counted over. It is only the raw
      // text, one unsplit string, that has no rows to narrow.
      filter.disabled = panel === "raw";
      document.body.classList.toggle("pcsv-reading-raw", panel === "raw");
    }

    // Counting is over the rows the filter left, not the file: a panel that answered for
    // all 20000 rows while the table above it showed 12 would be read as describing those
    // 12. The note says which it is.
    function renderStats() {
      statsNote.textContent = visible.length === numbered.length
        ? `Every column across all ${plural(numbered.length, "row")}.`
        : `Every column across the ${plural(visible.length, "row")} matching the filter.`;
      statsGrid.replaceChildren(...Array.from({ length: table.columns }, (_, column) => card(column)));
    }

    function card(column) {
      // A cell counts as empty when it holds nothing but space, and a row too short to
      // reach this column has no cell at all -- which is the same absence. A spelled-out
      // "NA" or "-" is a value the file chose to write, so it stays a value and shows up
      // in the list below, where it can be seen for what it is.
      const counts = new Map();
      let empty = 0;
      for (const entry of visible) {
        const value = entry.row[column];
        if (value === undefined || value.trim() === "") { empty++; continue; }
        counts.set(value, (counts.get(value) || 0) + 1);
      }
      // Commonest first, because that is the shape of the column. Equal counts fall back
      // to the collator the sort already uses, so a numeric column reads 2, 10, 50.
      const ranked = [...counts].sort((left, right) => right[1] - left[1] || sorter.compare(left[0], right[0]));

      const heading = element("h2", "pcsv-stat-name");
      heading.textContent = table.header?.[column]?.trim() || columnName(column);
      const meta = element("p", "pcsv-stat-meta");
      meta.textContent = `${plural(counts.size, "distinct value")} · ${empty
        ? `${empty.toLocaleString()} of ${plural(visible.length, "cell")} empty`
        : "no empty cells"}`;
      const top = element("div", "pcsv-stat-head");
      top.append(heading, meta);

      const list = element("ol", "pcsv-stat-values");
      list.append(...ranked.slice(0, MAX_VALUES).map(([value, times]) => {
        const text = element("span", "pcsv-stat-text");
        text.textContent = value;
        const seen = element("span", "pcsv-stat-count");
        seen.textContent = times.toLocaleString();
        const item = element("li");
        item.append(text, seen);
        return item;
      }));

      const node = element("section", "pcsv-stat");
      node.append(top, list);
      if (ranked.length > MAX_VALUES) {
        const more = element("p", "pcsv-stat-more");
        more.textContent = `+ ${plural(ranked.length - MAX_VALUES, "more value")}`;
        node.append(more);
      }
      return node;
    }

    function plural(count, noun) {
      return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
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
