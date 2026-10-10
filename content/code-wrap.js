// A code block whose lines run off the right edge is read a sentence at a time, sideways,
// and the scrollbar is usually at the very bottom of the block where the line you were on
// is not. This hangs a small switch in the top right corner of every block that overflows,
// which folds its long lines onto the next line instead.
//
// Per block, and off until clicked. Wrapping is not free: it breaks the column alignment of
// a diff, a table, or ASCII art, and it turns one numbered line into several. So the choice
// stays with the block in front of the reader rather than becoming a setting that quietly
// reflows every code block on the web.
productivityModules.register("code-wrap", () => {
  const STYLE_ID = "productivity-code-wrap";
  const BUTTON_CLASS = "productivity-code-wrap-button";
  // Also the marker for a block we have claimed, so its value carries the wrap state.
  const WRAP = "data-productivity-wrap";
  const SHEET = `
.${BUTTON_CLASS} {
  /* The page styles its own buttons, and a code block sits inside that reach. Start from
     nothing, then re-declare what the corner depends on so a stray rule cannot move it. */
  all: unset;
  position: absolute !important;
  top: 6px !important;
  right: 6px !important;
  z-index: 2 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  box-sizing: border-box !important;
  width: 24px !important;
  height: 24px !important;
  margin: 0 !important;
  padding: 0 !important;
  float: none !important;
  visibility: visible !important;
  pointer-events: auto !important;
  cursor: pointer;
  border-radius: 6px;
  /* currentColor is the block's own code colour, so the chip lands in the theme's palette
     whether the block is painted light or dark, and needs no second set of dark rules. */
  color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  background: color-mix(in srgb, currentColor 10%, transparent);
  opacity: 0 !important;
  transition: opacity 120ms ease, background-color 120ms ease;
}
/* Idle, the corner stays empty: the button is an answer to a block you are already reading,
   not an ornament on every block you scroll past. Keyboard users reach it through the block
   itself, which is focusable in most code themes, hence :focus-within. */
[${WRAP}]:hover > .${BUTTON_CLASS},
[${WRAP}]:focus-within > .${BUTTON_CLASS},
.${BUTTON_CLASS}:focus-visible,
[${WRAP}="on"] > .${BUTTON_CLASS} {
  opacity: 1 !important;
}
.${BUTTON_CLASS}:hover {
  background: color-mix(in srgb, currentColor 20%, transparent);
}
.${BUTTON_CLASS}:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 1px;
}
[${WRAP}="on"] > .${BUTTON_CLASS} {
  background: color-mix(in srgb, currentColor 24%, transparent);
}
.${BUTTON_CLASS} > svg {
  display: block !important;
  width: 15px !important;
  height: 15px !important;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
/* The block holds the text in themes that style the <pre>, and an inner <code> holds it in
   the themes that make that element the scroller. Both are claimed, with !important,
   because the rule being overruled here is the one the theme wrote on purpose. */
[${WRAP}="on"],
[${WRAP}="on"] code,
[${WRAP}="on"] samp {
  white-space: pre-wrap !important;
  /* A long line of code is often one unbroken token - a URL, a base64 blob, a path - which
     word boundaries cannot help with, so breaks are allowed anywhere they are needed. */
  overflow-wrap: anywhere !important;
  word-break: normal !important;
}
`;

  let active = true;
  let queued = false;
  // Block -> the button, the inline position we found, and the pin that keeps the button in
  // the corner. Entries are dropped as blocks leave the page, so nothing detached is held.
  const claimed = new Map();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = SHEET;
  (document.head || document.documentElement).appendChild(style);

  // Built node by node rather than from a markup string: a page that enforces Trusted Types
  // can reject innerHTML, and an icon is not worth a module that dies on those pages.
  function icon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ["M4 6h16", "M4 12h12a3.5 3.5 0 0 1 0 7h-5", "M13 16.5 10.5 19 13 21.5", "M4 18h3"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  function label(button, wrapped) {
    const text = wrapped ? "Stop wrapping long lines" : "Wrap long lines";
    button.title = text;
    button.setAttribute("aria-label", text);
    button.setAttribute("aria-pressed", String(wrapped));
  }

  // Reads as overflow whether the block scrolls or simply spills, since either way the text
  // is off the edge; a block that merely scrolls vertically has no sideways loss to fix.
  function overflows(node) {
    return node.scrollWidth - node.clientWidth > 1;
  }

  // Some themes scroll the <pre>; others leave it still and scroll an inner <code>. The
  // difference decides nothing about where the button goes, only whether it has to be
  // re-pinned, so both answers are treated the same and `pin` covers the first case.
  function overflowing(block) {
    if (overflows(block)) return true;
    for (const child of block.querySelectorAll("code, div, td")) if (overflows(child)) return true;
    return false;
  }

  function toggle(block) {
    const entry = claimed.get(block);
    if (!entry) return;
    entry.wrapped = !entry.wrapped;
    block.setAttribute(WRAP, entry.wrapped ? "on" : "off");
    label(entry.button, entry.wrapped);
    // Wrapping leaves nothing to scroll sideways, which resets scrollLeft without firing a
    // scroll event. Reading it back here is what moves the button home.
    entry.pin();
  }

  function attach(block) {
    if (claimed.has(block)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    label(button, false);
    button.appendChild(icon());
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      toggle(block);
    });
    const entry = {
      button,
      wrapped: false,
      position: block.style.position,
      priority: block.style.getPropertyPriority("position"),
      // An absolutely positioned child of a scrolling block scrolls with its text, so on a
      // block that is itself the scroller the button would ride off the edge it is pinned
      // to. Offsetting it by the scroll position holds it in the visible corner.
      pin: () => { button.style.transform = `translate(${block.scrollLeft}px, ${block.scrollTop}px)`; }
    };
    // The corner is measured from the block, which has to be a containing block for it.
    if (getComputedStyle(block).position === "static") block.style.setProperty("position", "relative");
    block.setAttribute(WRAP, "off");
    block.appendChild(button);
    block.addEventListener("scroll", entry.pin, { passive: true });
    // A block can already be scrolled when we reach it - a deep link into a long page, or
    // a module switched on mid-read - so the corner is found before it is first shown.
    entry.pin();
    claimed.set(block, entry);
  }

  function release(block) {
    const entry = claimed.get(block);
    if (!entry) return;
    claimed.delete(block);
    block.removeEventListener("scroll", entry.pin);
    entry.button.remove();
    block.removeAttribute(WRAP);
    if (entry.position) block.style.setProperty("position", entry.position, entry.priority);
    else block.style.removeProperty("position");
  }

  function refresh() {
    queued = false;
    if (!active) return;
    const present = new Set();
    for (const block of document.querySelectorAll("pre")) {
      // The CSV viewer keeps the original <pre> as its "Raw text" pane, inside its own
      // panel. That block already has a reader of its own; it does not need our corner.
      if (block.closest(".pcsv-host")) continue;
      present.add(block);
      const entry = claimed.get(block);
      // A wrapped block no longer overflows - that is the point - so it is never measured
      // again while wrapped. Taking its button away would strand it in that state.
      if (entry?.wrapped) continue;
      if (overflowing(block)) attach(block);
      // A window widened until the lines fit, or a block whose text was replaced by lines
      // that do, has nothing left to offer; the corner goes back to being empty.
      else if (entry) release(block);
    }
    for (const block of [...claimed.keys()]) if (!present.has(block)) release(block);
  }

  function queueRefresh() {
    if (queued || !active) return;
    queued = true;
    requestAnimationFrame(refresh);
  }

  const observer = new MutationObserver(queueRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", queueRefresh);
  queueRefresh();

  return () => {
    active = false;
    observer.disconnect();
    window.removeEventListener("resize", queueRefresh);
    for (const block of [...claimed.keys()]) release(block);
    style.remove();
  };
});
