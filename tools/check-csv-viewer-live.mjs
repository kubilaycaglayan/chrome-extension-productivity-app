// The claim this module rests on cannot be tested without a browser: Chrome hands a
// `text/csv` response to its downloader, so the navigation aborts and no content script
// runs. This loads the extension into a real Chrome, serves a CSV the way a server would —
// `text/csv`, with an attachment disposition — and checks that a table comes back.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const csv = await readFile(resolve(root, 'tests/fixtures/csv-viewer.csv'));
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'productivity-csv-viewer-'));
// Prose, to stand for every text file the viewer must keep its hands off.
const notes = 'Hello, world. This is a note.\nAnother line, with a comma in it.\nA third line.\nAnd a fourth.\n';
const server = createServer((request, response) => {
  if (request.url.endsWith('.txt')) {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(request.url.includes('notes') ? notes : csv);
    return;
  }
  // Exactly what makes a CSV link a download today: the honest type, plus a disposition
  // that would download the file even if the type were changed on its own.
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
  response.end(csv);
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(chromePath, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });
const browserExit = new Promise(done => browser.once('exit', done));
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await new Promise(done => setTimeout(done, 100)); }
  }
  if (!port) throw new Error('Chrome DevTools did not start');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ready, fail) => { socket.onopen = ready; socket.onerror = fail; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const call = (method, params = {}, sessionId) => new Promise(done => {
    const id = ++nextId;
    pending.set(id, done);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const wait = ms => new Promise(done => setTimeout(done, ms));
  const loaded = await call('Extensions.loadUnpacked', { path: root });
  if (loaded.error) throw new Error(JSON.stringify(loaded.error));
  const extensionId = loaded.result.id;
  const attach = async url => {
    const target = await call('Target.createTarget', { url });
    const sessionId = (await call('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
    return { targetId: target.result.targetId, sessionId };
  };
  const popup = await attach(`chrome-extension://${extensionId}/popup/popup.html`);
  const evaluate = async (expression, sessionId = popup.sessionId) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result.result.value;
  };

  // The rule lives in the dynamic store, written by the service worker on install, and the
  // popup's own `chrome` object is not there the instant the target attaches.
  const dynamicRules = () => evaluate('globalThis.chrome?.declarativeNetRequest?.getDynamicRules?.() ?? []');
  let rules = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    rules = (await dynamicRules()) || [];
    if (rules.some(rule => rule.id === 1100000)) break;
    await wait(100);
  }
  const rule = rules.find(entry => entry.id === 1100000);
  assert.ok(rule, 'the service worker must write the header rule');
  assert.equal(rule.action.type, 'modifyHeaders');
  const outcome = await evaluate(`chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url: `${origin}/report.csv`, type: 'main_frame' })})`);
  assert.ok(outcome.matchedRules.some(matched => matched.ruleId === 1100000), 'a CSV navigation must match the rule');
  // A page's own fetch of the same URL must be left with the type it asked for.
  const asFetch = await evaluate(`chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url: `${origin}/report.csv`, type: 'xmlhttprequest', initiator: origin })})`);
  assert.deepEqual(asFetch.matchedRules.filter(matched => matched.ruleId === 1100000), []);

  // Also used on pages the viewer deliberately leaves alone, so nothing here assumes a table.
  const read = async session => evaluate(`(() => {
    const heads = [...document.querySelectorAll('.pcsv-table thead th')];
    const scroll = document.querySelector('.pcsv-scroll');
    return {
      contentType: document.contentType,
      headers: heads.map(cell => cell.textContent),
      aligned: heads.map(cell => getComputedStyle(cell).textAlign),
      rows: [...document.querySelectorAll('.pcsv-table tbody tr')].map(row => [...row.children].map(cell => cell.textContent)),
      count: document.querySelector('.pcsv-count')?.textContent,
      sticky: heads[0] && getComputedStyle(heads[0]).position,
      gutter: scroll && getComputedStyle(scroll).scrollbarGutter,
      pre: !!document.querySelector('body > pre')
    };
  })()`, session);

  // The navigation that would have been a download.
  const page = await attach(`${origin}/report.csv`);
  await wait(700);
  const view = await read(page.sessionId);
  assert.equal(view.contentType, 'text/plain', 'the rule must relabel the response');
  assert.ok(!view.pre, 'the plain-text <pre> must have been replaced');
  assert.deepEqual(view.headers, ['#', 'product', 'stock', 'price', 'note']);
  // A semicolon file read as semicolons, with the quoted semicolon and comma left intact.
  assert.deepEqual(view.rows[1], ['2', 'bracket; small', '2', '1.50', 'has a semicolon, and a comma']);
  assert.deepEqual(view.rows[3], ['4', 'multi\nline', '7', '3.00', 'wrapped']);
  assert.equal(view.rows.length, 4);
  // Blank stock does not cost the column its numeric alignment.
  assert.deepEqual(view.aligned, ['right', 'left', 'right', 'right', 'left']);
  assert.match(view.count, /^4 rows · 4 columns · semicolon-separated$/);
  assert.equal(view.sticky, 'sticky', 'the header must stay put while the body scrolls');
  assert.equal(view.gutter, 'stable', 'the scrollbar must not shift the columns as rows are filtered');

  // Sorting and filtering, driven through the real DOM.
  const sorted = await evaluate(`(() => {
    const price = document.querySelectorAll('.pcsv-table thead th')[3];
    price.click();
    const up = [...document.querySelectorAll('.pcsv-table tbody tr')].map(row => row.children[3].textContent);
    price.click();
    const down = [...document.querySelectorAll('.pcsv-table tbody tr')].map(row => row.children[3].textContent);
    price.click();
    const back = [...document.querySelectorAll('.pcsv-table tbody tr')].map(row => row.children[3].textContent);
    return { up, down, back, sort: price.getAttribute('aria-sort') };
  })()`, page.sessionId);
  assert.deepEqual(sorted.up, ['0.25', '1.50', '3.00', '9.99']);
  assert.deepEqual(sorted.down, ['9.99', '3.00', '1.50', '0.25']);
  assert.deepEqual(sorted.back, ['9.99', '1.50', '0.25', '3.00'], 'a third click restores file order');
  assert.equal(sorted.sort, 'none');

  const filtered = await evaluate(`(async () => {
    const filter = document.querySelector('.pcsv-filter');
    filter.value = 'semicolon';
    filter.dispatchEvent(new Event('input'));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    return {
      rows: [...document.querySelectorAll('.pcsv-table tbody tr')].map(row => row.children[1].textContent),
      count: document.querySelector('.pcsv-count').textContent
    };
  })()`, page.sessionId);
  assert.deepEqual(filtered.rows, ['bracket; small']);
  assert.match(filtered.count, /^1 of 4 rows · /);

  const raw = await evaluate(`(() => {
    document.querySelector('.pcsv-toggle').click();
    return {
      text: document.querySelector('body > pre')?.textContent,
      table: !!document.querySelector('.pcsv-table'),
      bar: !!document.querySelector('.pcsv-bar'),
      label: document.querySelector('.pcsv-toggle').textContent
    };
  })()`, page.sessionId);
  assert.equal(raw.table, false, 'the table steps aside for the raw text');
  assert.equal(raw.bar, true, 'the toolbar survives the swap');
  assert.equal(raw.label, 'Table');
  assert.equal(raw.text, csv.toString(), 'the raw text must be the file, byte for byte');
  await call('Target.closeTarget', { targetId: page.targetId });

  // A text/plain file needs no rule at all: Chrome already renders it, and the viewer takes
  // it from there. This path keeps working when the rule is switched off, and it is how a
  // file like AmesHousing.txt — tab-separated, named .txt, served as text/plain — is read.
  const plain = await attach(`${origin}/report.txt`);
  await wait(700);
  const sniffed = await read(plain.sessionId);
  assert.deepEqual(sniffed.headers, ['#', 'product', 'stock', 'price', 'note'],
    'a .txt laid out like a table is read as one');
  assert.equal(sniffed.pre, false);
  await call('Target.closeTarget', { targetId: plain.targetId });

  // Prose keeps its own shape. Only one of its lines holds a comma, so nothing agrees.
  const prose = await attach(`${origin}/notes.txt`);
  await wait(700);
  const left_alone = await read(prose.sessionId);
  assert.equal(left_alone.pre, true, 'a text file that is not a table is left as text');
  assert.deepEqual(left_alone.headers, []);
  await call('Target.closeTarget', { targetId: prose.targetId });
  const named = await attach(`${origin}/export?file=report.csv`);
  await wait(700);
  const viaQuery = await read(named.sessionId);
  assert.deepEqual(viaQuery.headers, ['#', 'product', 'stock', 'price', 'note'], 'a CSV named in the query counts');
  await call('Target.closeTarget', { targetId: named.targetId });

  // Switching the module off takes the rule back, and the link is a download again.
  await evaluate(`chrome.storage.local.set({ 'moduleEnabled:csv-viewer': false })`);
  for (let attempt = 0; attempt < 100; attempt++) {
    const left = (await dynamicRules()) || [];
    if (!left.some(entry => entry.id === 1100000)) break;
    await wait(100);
  }
  const left = (await dynamicRules()) || [];
  assert.equal(left.some(entry => entry.id === 1100000), false, 'the rule must be taken back');
  const off = await attach('about:blank');
  await call('Page.enable', {}, off.sessionId);
  const aborted = await call('Page.navigate', { url: `${origin}/report.csv` }, off.sessionId);
  assert.match(aborted.result.errorText || '', /ERR_ABORTED/, 'with the module off, a CSV link downloads again');

  console.log('CSV viewer: a text/csv link renders as a sortable table, a .txt laid out like a table is read as one, prose is left alone, and switching the module off restores the download.');
} finally {
  socket?.close();
  server.close();
  browser.kill();
  await browserExit;
  await rm(profile, { recursive: true, force: true });
}
