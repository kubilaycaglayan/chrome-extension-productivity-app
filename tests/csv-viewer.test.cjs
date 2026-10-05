const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('the viewer, its parser and its network rule are wired into the extension', () => {
  // Both halves ride the group that already carries the module switch, so a page pays for
  // one injection rather than two.
  const group = manifest.content_scripts.find(entry => entry.js.includes('content/csv-viewer.js'));
  assert.ok(group, 'content/csv-viewer.js must be declared');
  assert.deepEqual(group.matches, ['<all_urls>']);
  assert.equal(group.run_at, 'document_start');
  assert.ok(group.js.includes('content/module-settings.js'), 'the module switch must load first');
  assert.ok(group.js.indexOf('shared/csv-table.js') < group.js.indexOf('content/csv-viewer.js'),
    'the parser must load before the viewer that calls it');
  // The header rule is dynamic, so nothing new is declared against the static quota.
  assert.equal(manifest.declarative_net_request.rule_resources.some(resource => /csv/.test(resource.id)), false);
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));

  const worker = read('background/service-worker.js');
  assert.match(worker, /import \{ initializeCsvViewer \} from "\.\.\/modules\/csv-viewer\.js";/);
  assert.match(worker, /^initializeCsvViewer\(\);$/m);

  const popup = read('popup/popup.js');
  assert.match(popup, /\["csv-viewer", "CSV viewer",/);
  // The switch, the export and the import all derive from MODULES, so the entry is enough.
  assert.match(popup, /const keys = MODULES\.map\(\(\[id\]\) => `moduleEnabled:\$\{id\}`\);/);
});

// Values cross the VM boundary, so they are rebuilt in this realm before `assert/strict`
// compares them against plain objects and arrays.
const plain = value => JSON.parse(JSON.stringify(value));

const table = (() => {
  const context = { console };
  vm.runInNewContext(read('shared/csv-table.js'), context);
  return context.csvTable;
})();

test('parsing follows RFC 4180 and the things real files do anyway', () => {
  assert.deepEqual(plain(table.parse('a,b\n1,2\n', ',')), [['a', 'b'], ['1', '2']]);
  // A trailing newline ends the file; it does not open an empty last row.
  assert.deepEqual(plain(table.parse('a,b\n', ',')), [['a', 'b']]);
  assert.deepEqual(plain(table.parse('a,b\r\n1,2', ',')), [['a', 'b'], ['1', '2']]);
  // A quoted field holds the delimiter, a doubled quote, and a line break.
  assert.deepEqual(plain(table.parse('"gadget, small",2', ',')), [['gadget, small', '2']]);
  assert.deepEqual(plain(table.parse('"say ""hi""",2', ',')), [['say "hi"', '2']]);
  assert.deepEqual(plain(table.parse('"line one\nline two",2', ',')), [['line one\nline two', '2']]);
  // A quote away from the start of a field is a literal inch mark, not a delimiter.
  assert.deepEqual(plain(table.parse('6" pipe,2', ',')), [['6" pipe', '2']]);
  assert.deepEqual(plain(table.parse('a,,c', ',')), [['a', '', 'c']]);
  assert.deepEqual(plain(table.parse('a,"",c', ',')), [['a', '', 'c']]);
  // Rows of differing width survive as written rather than being padded or dropped.
  assert.deepEqual(plain(table.parse('a,b,c\n1,2', ',')), [['a', 'b', 'c'], ['1', '2']]);
  assert.deepEqual(plain(table.parse('', ',')), []);
});

test('the delimiter is the one that makes the file rectangular', () => {
  assert.equal(table.detectDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.equal(table.detectDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(table.detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(table.detectDelimiter('a|b|c\n1|2|3\n'), '|');
  // A semicolon file whose text happens to contain commas still reads as semicolons: the
  // comma split leaves ragged rows, and consistency outranks column count.
  assert.equal(table.detectDelimiter('name;note\napple;red, round\npear;green, soft\n'), ';');
});

test('shape, not the file name, is what an unnamed text file is judged on', () => {
  const tabular = text => table.looksTabular(table.survey(text));
  // A tab-separated table like AmesHousing.txt: every line splits the same way.
  const ames = ['a\tb\tc', '1\t2\t3', '4\t5\t6', '7\t8\t9'].join('\n') + '\n';
  assert.equal(tabular(ames), true);
  assert.equal(plain(table.survey(ames)).columns, 3);
  assert.equal(plain(table.survey(ames)).agreement, 1);

  // Prose fails on agreement: the one sentence holding a comma is alone in doing so.
  assert.equal(tabular('Hello, world. This is a test.\nAnother sentence here.\nAnd a third.\n'), false);
  // A log with no delimiter at all never gets past one column.
  assert.equal(tabular('2026-01-01 12:00:00 INFO started\n2026-01-01 12:00:01 INFO ready\n2026-01-01 12:00:02 INFO done\n'), false);
  // Too few lines to be sure of anything.
  assert.equal(tabular('a,b\n1,2\n'), false);
  // One ragged line in four is below the bar; the same file whole is above it.
  assert.equal(tabular('a,b,c\n1,2,3\n4,5\n7,8,9\n'), false);
  assert.equal(tabular('a,b,c\n1,2,3\n4,5,6\n7,8,9\n'), true);
});

test('a first row of numbers above more numbers stays a data row', () => {
  const headed = table.read('name,qty\nwidget,2\nbolt,3\n');
  assert.deepEqual(plain(headed.header), ['name', 'qty']);
  assert.equal(headed.rows.length, 2);

  const headless = table.read('1,2\n3,4\n5,6\n');
  assert.equal(headless.header, null);
  assert.equal(headless.rows.length, 3, 'promoting the first row would hide a record');

  // A lone row is read as data for the same reason.
  assert.equal(table.read('1,2,3\n').header, null);
  assert.equal(table.read('a,b,c\n').header, null);
});

test('a number is only what a spreadsheet would write back out', () => {
  assert.equal(table.numberOf('42'), 42);
  assert.equal(table.numberOf(' -9.99 '), -9.99);
  assert.equal(table.numberOf('+1.5e3'), 1500);
  assert.equal(table.numberOf('1,234'), 1234);
  assert.equal(table.numberOf('1 234 567'), 1234567);
  assert.equal(table.numberOf(''), null);
  assert.equal(table.numberOf('n/a'), null);
  assert.equal(table.numberOf('12%'), null);
  // An ISO date sorts correctly as text and wrongly as a number, so it stays text.
  assert.equal(table.numberOf('2026-10-05'), null);
  // A decimal comma cannot be told from a thousands comma without the file's locale.
  assert.equal(table.numberOf('1.234,56'), null);

  const columns = plain(table.read('a,b,c\n1,1,x\n2,n/a,\n').numeric);
  assert.deepEqual(columns, [true, false, false], 'one non-number keeps a column text');
  // A column of nothing but blanks is not numeric either.
  assert.deepEqual(plain(table.read('a,b\n1,\n2,\n').numeric), [true, false]);
});

// A DOM stand-in with enough tree, classes and events for the viewer to run under node.
function page(text, { pathname = '/data.csv', contentType = 'text/plain', search = '' } = {}) {
  let body;
  const find = (node, selector) => {
    for (const child of node.children) {
      if (child.className.split(' ').includes(selector.slice(1))) return child;
      const deeper = find(child, selector);
      if (deeper) return deeper;
    }
    return null;
  };
  const node = tag => {
    const self = {
      tagName: tag.toUpperCase(),
      className: '',
      children: [],
      parentNode: null,
      attributes: {},
      listeners: new Map(),
      text: '',
      get textContent() {
        return self.children.length ? self.children.map(child => child.textContent).join('') : self.text;
      },
      set textContent(value) {
        for (const child of self.children) child.parentNode = null;
        self.children = [];
        self.text = String(value);
      },
      get isConnected() {
        let walk = self;
        while (walk.parentNode) walk = walk.parentNode;
        return walk === body;
      },
      adopt(child) {
        child.parentNode?.removeChild(child);
        child.parentNode = self;
        self.children.push(child);
        self.text = '';
      },
      append(...nodes) {
        for (const child of nodes) {
          if (!child.isFragment) { self.adopt(child); continue; }
          for (const grandchild of [...child.children]) self.adopt(grandchild);
        }
      },
      removeChild(child) {
        const at = self.children.indexOf(child);
        if (at >= 0) self.children.splice(at, 1);
        child.parentNode = null;
      },
      replaceChildren(...nodes) {
        for (const child of self.children) child.parentNode = null;
        self.children = [];
        self.text = '';
        self.append(...nodes);
      },
      replaceWith(other) {
        const parent = self.parentNode;
        if (!parent) return;
        const at = parent.children.indexOf(self);
        other.parentNode?.removeChild(other);
        parent.children[at] = other;
        other.parentNode = parent;
        self.parentNode = null;
      },
      remove() { self.parentNode?.removeChild(self); },
      setAttribute(name, value) { self.attributes[name] = String(value); },
      getAttribute(name) { return self.attributes[name] ?? null; },
      addEventListener(name, handler) {
        if (!self.listeners.has(name)) self.listeners.set(name, []);
        self.listeners.get(name).push(handler);
      },
      dispatch(name) { for (const handler of self.listeners.get(name) ?? []) handler({ type: name, target: self }); },
      querySelector(selector) { return find(self, selector); },
      classList: {
        toggle(name, on) {
          const held = new Set(self.className.split(' ').filter(Boolean));
          if (on ?? !held.has(name)) held.add(name); else held.delete(name);
          self.className = [...held].join(' ');
        },
        contains(name) { return self.className.split(' ').filter(Boolean).includes(name); }
      }
    };
    return self;
  };

  body = node('body');
  const pre = node('pre');
  pre.textContent = text;
  body.append(pre);
  let frames = [];
  let start;
  const context = vm.createContext({
    productivityModules: { register(id, callback) { assert.equal(id, 'csv-viewer'); start = callback; } },
    document: {
      contentType,
      readyState: 'complete',
      body,
      createElement: node,
      createDocumentFragment: () => Object.assign(node('#fragment'), { isFragment: true }),
      querySelector: selector => (selector === 'body > pre' ? body.children.find(child => child.tagName === 'PRE') ?? null : null),
      addEventListener() {},
      removeEventListener() {}
    },
    location: { pathname, search },
    requestAnimationFrame: callback => frames.push(callback) && frames.length,
    cancelAnimationFrame: () => {},
    Intl,
    console
  });
  vm.runInContext(read('shared/csv-table.js'), context);
  vm.runInContext(read('content/csv-viewer.js'), context);
  const stop = start();
  const view = {
    body,
    pre,
    stop,
    flush() { const due = frames; frames = []; for (const callback of due) callback(); },
    get bar() { return body.children.find(child => child.className === 'pcsv-bar'); },
    get sheet() { return find(body, '.pcsv-table'); },
    get rows() { return view.sheet.children.find(child => child.tagName === 'TBODY').children; },
    get headers() { return view.sheet.children.find(child => child.tagName === 'THEAD').children[0].children; },
    cells: row => row.children.map(cell => cell.textContent),
    column: index => view.rows.map(row => row.children[index].textContent),
    control: className => find(body, className)
  };
  return view;
}

test('a CSV becomes a table of columns, numbers right-aligned, rows still numbered', () => {
  const view = page('name,qty,price\nwidget,2,9.99\n"gadget, small",10,1.50\nbolt,,0.25\n');
  assert.deepEqual(view.headers.map(cell => cell.textContent), ['#', 'name', 'qty', 'price']);
  // A quoted comma stays inside its own cell rather than opening a fourth column.
  assert.deepEqual(view.cells(view.rows[1]), ['2', 'gadget, small', '10', '1.50']);
  assert.equal(view.rows.length, 3);
  // The blank in a column of numbers does not make the column text.
  assert.deepEqual(view.headers.map(cell => cell.className), ['pcsv-corner', '', 'pcsv-number', 'pcsv-number']);
  assert.deepEqual(view.rows[0].children.map(cell => cell.className), ['pcsv-line', '', 'pcsv-number', 'pcsv-number']);
  assert.match(view.control('.pcsv-count').textContent, /^3 rows · 3 columns · comma-separated$/);
  assert.equal(view.control('.pcsv-name').textContent, 'data.csv');
  // The original text is kept aside, out of the tree, for the raw toggle to bring back.
  assert.equal(view.pre.isConnected, false);
});

test('a headerless file keeps every row and labels its columns like a spreadsheet', () => {
  const view = page('1,2,3\n4,5,6\n');
  assert.deepEqual(view.headers.map(cell => cell.textContent), ['#', 'A', 'B', 'C']);
  assert.equal(view.rows.length, 2);
});

test('clicking a header sorts ascending, then descending, then back to file order', () => {
  const view = page('name,qty\nwidget,10\nbolt,2\ncap,33\n');
  const qty = view.headers[2];
  assert.deepEqual(view.column(2), ['10', '2', '33']);

  qty.dispatch('click');
  // A numeric column sorts by value, so 2 leads and 33 trails.
  assert.deepEqual(view.column(2), ['2', '10', '33']);
  assert.equal(qty.getAttribute('aria-sort'), 'ascending');
  assert.equal(qty.querySelector('.pcsv-arrow').textContent, '▴');

  qty.dispatch('click');
  assert.deepEqual(view.column(2), ['33', '10', '2']);
  assert.equal(qty.getAttribute('aria-sort'), 'descending');

  qty.dispatch('click');
  assert.deepEqual(view.column(2), ['10', '2', '33'], 'a third click restores the file order');
  assert.equal(qty.getAttribute('aria-sort'), 'none');
  assert.equal(qty.querySelector('.pcsv-arrow').textContent, '');
  // The line numbers travel with their rows, so a sorted value can still be found in the file.
  assert.deepEqual(view.column(0), ['1', '2', '3']);
});

test('sorting text leaves blanks last in both directions and keeps ties in file order', () => {
  const view = page('name,note\nb,\na,second\nc,\nd,first\n');
  const note = view.headers[2];
  note.dispatch('click');
  assert.deepEqual(view.column(2), ['first', 'second', '', '']);
  assert.deepEqual(view.column(0), ['4', '2', '1', '3'], 'the two blanks keep their file order');
  note.dispatch('click');
  assert.deepEqual(view.column(2), ['second', 'first', '', ''], 'blanks stay last when reversed');
});

test('the filter keeps rows matching every term and says how many are left', () => {
  const view = page('name,city\nAnna,Ankara\nBerk,Izmir\nCan,Ankara\n');
  const filter = view.control('.pcsv-filter');
  filter.value = 'ankara';
  filter.dispatch('input');
  view.flush();
  assert.deepEqual(view.column(1), ['Anna', 'Can'], 'matching is case-insensitive');
  assert.match(view.control('.pcsv-count').textContent, /^2 of 3 rows · /);

  // Several terms all have to appear, which narrows to one row without naming a column.
  filter.value = 'ankara can';
  filter.dispatch('input');
  view.flush();
  assert.deepEqual(view.column(1), ['Can']);

  filter.value = '';
  filter.dispatch('input');
  view.flush();
  assert.equal(view.rows.length, 3);
  assert.match(view.control('.pcsv-count').textContent, /^3 rows · /);
});

test('a file too tall to render says how many rows it is holding back', () => {
  const rows = Array.from({ length: 20005 }, (_, index) => `row${index},${index}`).join('\n');
  const view = page(`name,n\n${rows}\n`);
  assert.equal(view.rows.length, 20000, 'the table stops at the cap');
  assert.match(view.control('.pcsv-count').textContent, /^20,005 rows · 2 columns · comma-separated · showing first 20,000$/);
  // Filtering below the cap drops the caveat, because nothing is being held back any more.
  const filter = view.control('.pcsv-filter');
  filter.value = 'row19999';
  filter.dispatch('input');
  view.flush();
  assert.equal(view.rows.length, 1);
  assert.match(view.control('.pcsv-count').textContent, /^1 of 20,005 rows · 2 columns · comma-separated$/);
});

test('"Raw text" swaps the table for the original file and back, and the toolbar stays', () => {
  const view = page('name,qty\nwidget,2\nbolt,3\n');
  const toggle = view.control('.pcsv-toggle');
  const scroll = view.control('.pcsv-scroll');

  toggle.dispatch('click');
  assert.equal(view.pre.isConnected, true);
  assert.equal(scroll.isConnected, false);
  assert.equal(toggle.textContent, 'Table');
  assert.equal(view.bar.isConnected, true, 'the toolbar must survive the swap');
  assert.equal(view.control('.pcsv-filter').disabled, true);
  assert.equal(view.body.classList.contains('pcsv-reading-raw'), true);

  toggle.dispatch('click');
  assert.equal(view.pre.isConnected, false);
  assert.equal(scroll.isConnected, true);
  assert.equal(toggle.textContent, 'Raw text');
  assert.equal(view.control('.pcsv-filter').disabled, false);
});

test('switching the module off puts the original page back', () => {
  const view = page('name,qty\nwidget,2\nbolt,3\n');
  view.stop();
  assert.deepEqual(view.body.children, [view.pre]);
  assert.equal(view.body.className, '');
});

test('the viewer leaves alone anything that is not a CSV page it can improve', () => {
  // Chrome's own viewer renders text/plain; anything else is a real page with its own layout.
  assert.equal(page('name,qty\nwidget,2\n', { contentType: 'text/html' }).bar, undefined);
  // A text file whose shape is not convincing is left as text rather than guessed at.
  assert.equal(page('name,qty\nwidget,2\n', { pathname: '/notes.txt' }).bar, undefined);
  assert.equal(page('Hello, world. A test.\nAnother line.\nAnd a third.\n', { pathname: '/notes.txt' }).bar, undefined);
  // A one-column file is a list, and the <pre> already shows a list perfectly well.
  assert.equal(page('name\nwidget\nbolt\n').bar, undefined);
  assert.equal(page('   \n').bar, undefined);
  // A lone row is still two columns worth reading, and it is read as data, not a heading.
  const single = page('widget,2\n');
  assert.deepEqual(single.headers.map(cell => cell.textContent), ['#', 'A', 'B']);
  assert.equal(single.rows.length, 1);
  // A CSV reached through a query string still counts.
  assert.ok(page('a,b\n1,2\n', { pathname: '/export', search: '?file=data.csv' }).bar);
});

test('a text file laid out like a table is read as one, whatever it is called', () => {
  // The shape of AmesHousing.txt: tab-separated, named .txt, served as text/plain.
  const rows = Array.from({ length: 6 }, (_, index) => `house${index}\t${index * 10}\tAmes`).join('\n');
  const view = page(`name\tarea\tcity\n${rows}\n`, { pathname: '/v19n3/decock/AmesHousing.txt' });
  assert.deepEqual(view.headers.map(cell => cell.textContent), ['#', 'name', 'area', 'city']);
  assert.equal(view.rows.length, 6);
  assert.match(view.control('.pcsv-count').textContent, /^6 rows · 3 columns · tab-separated$/);
  assert.equal(view.control('.pcsv-name').textContent, 'AmesHousing.txt');
});

test('a file named .csv is taken at its word even when its shape is thin', () => {
  // Two rows would not convince the sniffer, but the name is a promise and is trusted.
  const view = page('name,qty\nwidget,2\n');
  assert.deepEqual(view.headers.map(cell => cell.textContent), ['#', 'name', 'qty']);
  assert.equal(view.rows.length, 1);
});

// The network rule, driven through a stand-in for the declarativeNetRequest store.
function worker(stored) {
  const source = read('modules/csv-viewer.js')
    .replaceAll('export const ', 'const ')
    .replaceAll('export function ', 'function ') + '\nthis.api = { initializeCsvViewer, viewerRule };';
  const calls = [];
  let rules = [];
  const listeners = [];
  const context = {
    console,
    chrome: {
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      storage: {
        local: { get: async () => ({ ...stored }) },
        onChanged: { addListener: listener => listeners.push(listener) }
      },
      declarativeNetRequest: {
        getDynamicRules: async () => rules.map(rule => ({ ...rule, condition: { ...rule.condition, isUrlFilterCaseSensitive: false } })),
        async updateDynamicRules(update) {
          calls.push(update);
          rules = rules.filter(rule => !(update.removeRuleIds ?? []).includes(rule.id)).concat(update.addRules ?? []);
        }
      }
    }
  };
  vm.runInNewContext(source, context);
  return {
    api: context.api,
    calls,
    get rules() { return rules; },
    seed(rule) { rules = [rule]; },
    change: async value => {
      stored['moduleEnabled:csv-viewer'] = value;
      for (const listener of listeners) listener({ 'moduleEnabled:csv-viewer': { newValue: value } }, 'local');
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    settle: () => new Promise(resolve => setTimeout(resolve, 0))
  };
}

test('the rule relabels only CSV navigations, and outranks the ad blocker pause rules', () => {
  const { api } = worker({});
  const rule = api.viewerRule;
  assert.deepEqual(plain(rule.action.responseHeaders), [
    { header: 'content-type', operation: 'set', value: 'text/plain; charset=utf-8' },
    { header: 'content-disposition', operation: 'remove' }
  ]);
  // A page's own fetch of a CSV must keep the type it asked for.
  assert.deepEqual(plain(rule.condition.resourceTypes), ['main_frame']);
  // An allowAllRequests rule cancels a header rule beneath it, and the ad blocker writes
  // one at 1000000 for every site it is paused on.
  assert.ok(rule.priority > 1000000);
  // Clear of the ad blocker's own dynamic ids, which start at 1000000.
  assert.ok(rule.id >= 1100000);

  const matches = url => new RegExp(rule.condition.regexFilter, 'i').test(url);
  assert.ok(matches('https://example.com/data.csv'));
  assert.ok(matches('http://example.com/a/b/REPORT.CSV'));
  assert.ok(matches('https://example.com/data.tsv?v=2'));
  assert.ok(matches('https://example.com/export?name=data.csv'));
  assert.equal(matches('https://example.com/data.csv.zip'), false);
  assert.equal(matches('https://example.com/page.html'), false);
  // A fragment is never sent to a server, so it cannot be what names the file.
  assert.equal(matches('https://example.com/page#data.csv'), false);
});

test('the rule is written when the module is on, taken back when it is off, and never twice', async () => {
  const store = worker({});
  store.api.initializeCsvViewer();
  await store.settle();
  // Enabled is the default, so a fresh profile gets the rule without being asked.
  assert.deepEqual(store.rules.map(rule => rule.id), [1100000]);
  assert.equal(store.calls.length, 1);

  await store.change(false);
  assert.deepEqual(store.rules, []);
  assert.equal(store.calls.length, 2);

  await store.change(true);
  assert.deepEqual(store.rules.map(rule => rule.id), [1100000]);
  // A rule already in the store is left alone: Chrome echoes its own defaults back, and
  // comparing the whole echo would rewrite the rule on every wake.
  await store.change(true);
  assert.equal(store.calls.length, 3);
});

test('a rule left behind by an earlier version is replaced rather than kept', async () => {
  const store = worker({});
  store.seed({ ...store.api.viewerRule, priority: 1, action: { type: 'block' } });
  store.api.initializeCsvViewer();
  await store.settle();
  assert.equal(store.rules.length, 1);
  assert.equal(store.rules[0].action.type, 'modifyHeaders');
  assert.equal(store.rules[0].priority, store.api.viewerRule.priority);
  assert.deepEqual(plain(store.calls[0].removeRuleIds), [1100000]);
});
