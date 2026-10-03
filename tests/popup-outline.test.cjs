const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');
const functions = source.slice(source.indexOf('function collectPageHeadings()'), source.indexOf('async function loadOutline()'));

function heading(tagName, textContent, options = {}) {
  return {
    tagName,
    textContent,
    closest: () => options.hidden ? {} : null,
    getClientRects: () => options.visible === false ? [] : [{}],
    scrollIntoView: options.scrollIntoView || (() => {})
  };
}

function page(headings, mainIndices = []) {
  const main = mainIndices.length ? { contains: item => mainIndices.includes(headings.indexOf(item)) } : null;
  const context = {
    document: {
      querySelectorAll: () => headings,
      querySelector: () => main
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  };
  vm.runInNewContext(`${functions}; this.collect = collectPageHeadings; this.jump = jumpToHeading;`, context);
  return context;
}

test('outlines visible headings in main and preserves their document indices', () => {
  const headings = [
    heading('H2', 'Site menu'),
    heading('H1', 'Article title'),
    heading('H2', '  First   section  '),
    heading('H3', 'Hidden section', { hidden: true }),
    heading('H2', 'Second section'),
    heading('H2', 'Footer')
  ];
  const outline = page(headings, [1, 2, 3, 4]).collect();
  assert.deepEqual(Array.from(outline, item => ({ ...item })), [
    { index: 1, level: 1, text: 'Article title' },
    { index: 2, level: 2, text: 'First section' },
    { index: 4, level: 2, text: 'Second section' }
  ]);
});

test('falls back to all visible headings when the page has no main headings', () => {
  const outline = page([heading('H2', 'Page title'), heading('H3', 'Offscreen', { visible: false })]).collect();
  assert.equal(outline.length, 1);
  assert.equal(outline[0].text, 'Page title');
});

test('jumps to the selected heading and rejects an outdated outline', () => {
  let scrolled = false;
  const title = heading('H2', 'Target', { scrollIntoView: () => { scrolled = true; } });
  const context = page([title]);
  assert.equal(context.jump(0, 'Target'), true);
  assert.equal(scrolled, true);
  scrolled = false;
  title.textContent = 'Changed';
  assert.equal(context.jump(0, 'Target'), false);
  assert.equal(scrolled, false);
});
