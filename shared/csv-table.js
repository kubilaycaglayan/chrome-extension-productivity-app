// Reading delimited text, with no DOM in sight: the viewer, the popup and the tests all
// agree on how a file splits into columns because they all come through here.
globalThis.csvTable = {
  // Semicolon files come out of European spreadsheets, tabs out of database exports, and
  // pipes out of hand-rolled dumps. Which one a file uses is a guess, so it is a scored one.
  delimiters: [",", ";", "\t", "|"],

  // Only the shapes a spreadsheet writes back out: an optional sign, digits that may be
  // grouped by spaces or commas, an optional fraction, an optional exponent. Deliberately
  // not "1.234,56" — a decimal comma cannot be told from a thousands comma without knowing
  // the file's locale, and guessing wrong silently reorders a sort.
  number: /^[-+]?(?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?$/,

  numberOf(value) {
    if (typeof value !== "string") return null;
    const text = value.trim().replace(/\s+/g, " ");
    if (!this.number.test(text)) return null;
    const number = Number(text.replace(/[ ,]/g, ""));
    return Number.isFinite(number) ? number : null;
  },

  // RFC 4180, plus the two things real files do anyway: CRLF line breaks, and rows of
  // differing width. A quote opens a field only at its start, so `6" pipe` stays literal.
  parse(text, delimiter) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    let started = false;
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (quoted) {
        if (char !== '"') { field += char; index++; continue; }
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        quoted = false;
        index++;
        continue;
      }
      if (char === '"' && field === "") { quoted = true; started = true; index++; continue; }
      if (char === delimiter) { row.push(field); field = ""; started = true; index++; continue; }
      if (char === "\n" || char === "\r") {
        if (char === "\r" && text[index + 1] === "\n") index++;
        index++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        started = false;
        continue;
      }
      field += char;
      started = true;
      index++;
    }
    // A trailing newline ends the file rather than opening an empty last row.
    if (started || field || row.length) { row.push(field); rows.push(row); }
    return rows;
  },

  // Enough of the file to pick a delimiter and judge the shape, without parsing a 30 MB
  // log in full only to discover it was never a table.
  sample: 65536,

  // Consistency decides, width breaks ties: a file of semicolons beats the same file read
  // as commas, where one stray comma inside a quoted note splits a single row too far.
  // `agreement` — the share of lines that split the same way — is also what tells a data
  // file apart from prose, which is the only thing to go on when the name does not say.
  survey(text) {
    const sample = text.slice(0, this.sample);
    const truncated = sample.length < text.length;
    let best = { delimiter: ",", columns: 0, rows: 0, agreement: 0, score: -1 };
    for (const delimiter of this.delimiters) {
      const rows = this.parse(sample, delimiter);
      // The cut landed mid-line, so the last row is short through no fault of the file.
      if (truncated && rows.length > 1) rows.pop();
      if (!rows.length) continue;
      const counts = new Map();
      for (const row of rows) counts.set(row.length, (counts.get(row.length) || 0) + 1);
      const [columns, agreeing] = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
      if (columns < 2) continue;
      const agreement = agreeing / rows.length;
      const score = agreement * 100 + Math.min(columns, 50);
      if (score > best.score) best = { delimiter, columns, rows: rows.length, agreement, score };
    }
    return best;
  },

  // A file whose name says `.csv` is taken at its word. A file that does not say has to
  // look unmistakable instead: several lines, more than one column, and nearly all of
  // those lines splitting into the same number of fields. Prose fails on the last count,
  // because a sentence that happens to hold a comma is alone in doing so.
  looksTabular(survey) {
    return survey.columns >= 2 && survey.rows >= 3 && survey.agreement >= 0.95;
  },

  detectDelimiter(text) {
    return this.survey(text).delimiter;
  },

  // A first row of numbers sitting above more numbers is data, and promoting it to a
  // heading would hide a record. Everything else is read as a heading, which is what
  // almost every exported file carries.
  looksLikeHeader(rows) {
    if (rows.length < 2) return false;
    const [first, ...rest] = rows;
    return !first.some((cell, column) =>
      this.numberOf(cell) !== null && rest.some(row => this.numberOf(row[column]) !== null));
  },

  // Right-alignment and numeric sorting both hang off this: a column counts as numeric
  // only when every value it does hold is a number, so one "n/a" keeps it text.
  numericColumns(rows, columns) {
    return Array.from({ length: columns }, (_, column) => {
      let seen = 0;
      for (const row of rows) {
        const value = row[column];
        if (value === undefined || value.trim() === "") continue;
        if (this.numberOf(value) === null) return false;
        seen++;
      }
      return seen > 0;
    });
  },

  read(text, delimiter = null) {
    const clean = text.replace(/^\uFEFF/, "");
    delimiter ??= this.detectDelimiter(clean);
    const table = this.parse(clean, delimiter);
    const columns = table.reduce((widest, row) => Math.max(widest, row.length), 0);
    const headed = this.looksLikeHeader(table);
    const rows = headed ? table.slice(1) : table;
    return {
      delimiter,
      header: headed ? table[0] : null,
      rows,
      columns,
      numeric: this.numericColumns(rows, columns)
    };
  }
};
