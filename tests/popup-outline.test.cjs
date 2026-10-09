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

// popup.js is one long top-level script written against a popup that is already in the
// DOM, so testing which view it opens on means supplying that DOM. Elements are minted on
// demand by id, which keeps this to the handful of behaviours the script actually uses.
function popup({ headings = [], stored = {}, tab = { id: 7, url: 'https://example.com/' }, reachable = true } = {}) {
  const nodes = new Map();
  const node = () => {
    const self = {
      className: '', title: '', id: '', value: '', hidden: false, disabled: false, checked: false,
      children: [], attributes: {}, listeners: new Map(), dataset: {}, text: '',
      get textContent() {
        return self.children.length ? self.children.map(child => child.textContent).join('') : self.text;
      },
      set textContent(value) { self.children = []; self.text = String(value); },
      append(...kids) { self.children.push(...kids); self.text = ''; },
      appendChild(kid) { self.append(kid); return kid; },
      prepend(kid) { self.children.unshift(kid); },
      replaceChildren(...kids) { self.children = [...kids]; self.text = ''; },
      remove() {},
      setAttribute(name, value) { self.attributes[name] = String(value); },
      getAttribute(name) { return self.attributes[name] ?? null; },
      addEventListener(name, handler) {
        if (!self.listeners.has(name)) self.listeners.set(name, []);
        self.listeners.get(name).push(handler);
      },
      dispatch(name) {
        for (const handler of self.listeners.get(name) ?? []) handler({ type: name, target: self, preventDefault() {} });
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false }
    };
    return self;
  };
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, Object.assign(node(), { id }));
    return nodes.get(id);
  };
  // The popup opens on the outline, exactly as popup.html ships it.
  byId('settings-view').hidden = true;

  const context = vm.createContext({
    document: {
      body: node(),
      getElementById: byId,
      createElement: node,
      addEventListener() {},
      removeEventListener() {}
    },
    // Both personal lists live in gitignored files that a test profile does not have, and
    // the popup is written to prefill nothing when the fetch fails.
    fetch: async () => { throw new Error('no local list'); },
    chrome: {
      tabs: { query: async () => (tab ? [tab] : []) },
      storage: {
        local: { get: async () => ({ ...stored }), set: async () => {} },
        onChanged: { addListener() {} }
      },
      scripting: {
        executeScript: async () => {
          if (!reachable) throw new Error('cannot access this page');
          return [{ result: headings }];
        }
      },
      runtime: {
        getURL: file => file,
        sendMessage: async () => ({ ok: true, enabled: true, sites: [], extraEnabled: true })
      }
    },
    console
  });
  for (const file of ['mackolik-settings', 'newtab-settings', 'x-keywords', 'cookie-accepter-settings']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../shared/${file}.js`), 'utf8'), context);
  }
  vm.runInContext(source, context);
  return {
    byId,
    get showing() {
      if (!byId('outline-view').hidden) return 'outline';
      return byId('settings-view').hidden ? 'neither' : 'settings';
    },
    // Every stand-in promise is already resolved, so one turn of the event loop drains
    // the whole chain the popup kicked off at load.
    settle: () => new Promise(resolve => setImmediate(resolve))
  };
}

const outlined = { index: 0, level: 1, text: 'Article title' };

test('a page with headings opens the popup on its outline', async () => {
  const view = popup({ headings: [outlined] });
  await view.settle();
  assert.equal(view.showing, 'outline');
  assert.equal(view.byId('outline-count').textContent, '1 HEADING');
});

test('a page with no headings opens the popup on Settings instead', async () => {
  // An outline is the popup's front door and this page has nothing behind it, so the
  // controls the user can still act on are what they are given.
  const view = popup({ headings: [] });
  await view.settle();
  assert.equal(view.showing, 'settings');
  // The reason is still written behind it, which is what the back button leads to.
  assert.equal(view.byId('outline-message').textContent, 'No headings found on this page.');
  assert.equal(view.byId('outline-count').textContent, '0 HEADINGS');
});

test('Settings is not a trap: going back to an empty outline stays there', async () => {
  const view = popup({ headings: [] });
  await view.settle();
  assert.equal(view.showing, 'settings');

  // The second load is one the user asked for by pressing back. Sending them to Settings
  // again would leave no way out of it.
  view.byId('back-to-outline').dispatch('click');
  await view.settle();
  assert.equal(view.showing, 'outline');
  assert.equal(view.byId('outline-message').textContent, 'No headings found on this page.');

  // Nor does asking for a refresh of an outline that is still empty throw the user out.
  view.byId('refresh-outline').dispatch('click');
  await view.settle();
  assert.equal(view.showing, 'outline');
});

test('a page the outline cannot reach, and a module switched off, both open on Settings', async () => {
  const unreachable = popup({ reachable: false });
  await unreachable.settle();
  assert.equal(unreachable.showing, 'settings');
  assert.equal(unreachable.byId('outline-message').textContent, 'This page cannot be outlined. Try a regular website tab.');

  const off = popup({ headings: [outlined], stored: { 'moduleEnabled:page-outline': false } });
  await off.settle();
  assert.equal(off.showing, 'settings');
  assert.equal(off.byId('outline-message').textContent, 'Page outline is turned off. Enable it in Settings.');
});
