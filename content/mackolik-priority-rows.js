// Move original rows within their table so IDs, handlers, and live updates survive.
globalThis.createMackolikPriorityRows = (attribute) => {
  const tables = new Map();

  function restore(entry) {
    const details = entry.row.nextElementSibling;
    entry.placeholder.replaceWith(entry.row);
    if (details?.id?.startsWith("odds")) entry.row.after(details);
  }

  function update(table) {
    let state = tables.get(table);
    if (!state) {
      state = { body: document.createElement("tbody"), rows: new Map(), headers: new Map(), titles: new Map(), gap: null, trailingGap: null };
      state.body.setAttribute("data-productivity-priority-rows", "");
      tables.set(table, state);
    }
    for (const [row, entry] of state.rows) {
      if (!row.isConnected) {
        entry.placeholder.remove();
        state.rows.delete(row);
        continue;
      }
      if (!row.hasAttribute(attribute) || row.getAttribute("sport") !== "1" || !entry.placeholder.isConnected) {
        if (entry.placeholder.isConnected) restore(entry);
        state.rows.delete(row);
      }
    }
    // Mackolik explicitly marks football as 1, basketball as 2, and duels as 0.
    // Rows without a known football marker remain in their original positions.
    for (const row of table.querySelectorAll(`tr.row[sport="1"][${attribute}]`)) {
      if (state.rows.has(row)) continue;
      let header = row.previousElementSibling;
      while (header && !header.matches(".rows-bg, .dateHeader")) header = header.previousElementSibling;
      const placeholder = document.createComment("productivity-match-original-position");
      row.before(placeholder);
      state.rows.set(row, { row, header, placeholder });
    }
    if (!state.rows.size) {
      state.body.remove();
      state.headers.clear();
      return;
    }
    if (table.tBodies[0] !== state.body) table.insertBefore(state.body, table.tBodies[0] || null);
    const entries = [...state.rows.values()].sort((a, b) => {
      const rank = row => row.getAttribute(attribute) === "followed" ? 1 : 0;
      return rank(a.row) - rank(b.row) || (a.placeholder.compareDocumentPosition(b.placeholder) & 4 ? -1 : 1);
    });
    const desired = [];
    let lastHeader = null;
    let lastGroup = null;
    for (const entry of entries) {
      const group = entry.row.getAttribute(attribute);
      if (group !== lastGroup) {
        if (group === "followed") {
          if (!state.gap) {
            state.gap = document.createElement("tr");
            state.gap.className = "productivity-group-gap";
            state.gap.setAttribute("aria-hidden", "true");
            const cell = document.createElement("td");
            cell.colSpan = [...entry.row.cells].reduce((total, cell) => total + cell.colSpan, 0);
            state.gap.appendChild(cell);
          }
          desired.push(state.gap);
        }
        let title = state.titles.get(group);
        if (!title) {
          title = document.createElement("tr");
          title.className = "productivity-team-group";
          title.setAttribute("data-group", group);
          const cell = document.createElement("td");
          cell.colSpan = [...entry.row.cells].reduce((total, cell) => total + cell.colSpan, 0);
          cell.textContent = group === "followed" ? "Takip ettiğim takımlar" : "Ana takımlarım";
          title.appendChild(cell);
          state.titles.set(group, title);
        }
        desired.push(title);
        lastGroup = group;
        lastHeader = null;
      }
      if (entry.header && entry.header !== lastHeader) {
        let copies = state.headers.get(entry.header);
        if (!copies) {
          copies = new Map();
          state.headers.set(entry.header, copies);
        }
        let copy = copies.get(group);
        if (!copy) {
          copy = entry.header.cloneNode(true);
          copy.removeAttribute("id");
          copy.querySelectorAll("[id]").forEach(node => node.removeAttribute("id"));
          copies.set(group, copy);
        }
        desired.push(copy);
      }
      lastHeader = entry.header;
      desired.push(entry.row);
      // Keep expanded odds/details attached to their match when present.
      const details = entry.row.nextElementSibling;
      if (details?.id?.startsWith("odds")) desired.push(details);
    }
    if (!state.trailingGap) {
      state.trailingGap = document.createElement("tr");
      state.trailingGap.className = "productivity-list-gap";
      state.trailingGap.setAttribute("aria-hidden", "true");
      const cell = document.createElement("td");
      cell.colSpan = [...entries[0].row.cells].reduce((total, item) => total + item.colSpan, 0);
      state.trailingGap.appendChild(cell);
    }
    desired.push(state.trailingGap);
    let cursor = state.body.firstElementChild;
    for (const node of desired) {
      if (node !== cursor) state.body.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
    }
    const wanted = new Set(desired);
    for (const node of [...state.body.children]) {
      if (!wanted.has(node)) node.remove();
    }
    for (const [header, copies] of state.headers) {
      for (const [group, copy] of copies) if (!wanted.has(copy)) copies.delete(group);
      if (!copies.size) state.headers.delete(header);
    }
  }

  return {
    refresh() {
      for (const [table] of tables) {
        if (!table.isConnected) tables.delete(table);
      }
      document.querySelectorAll("#dvScores .list-table").forEach(update);
    },
    cleanup() {
      for (const state of tables.values()) {
        for (const entry of state.rows.values()) {
          if (entry.placeholder.isConnected) {
            restore(entry);
          }
        }
        state.body.remove();
      }
      tables.clear();
    }
  };
};
