// What this module claims needs real layout to check: that a block's lines run off the
// edge, that the button lands in the visible top right corner of the box that holds still,
// and that one click actually folds the lines. None of that exists without a browser, so
// this loads the extension into a real Chrome against a page built the way documentation
// sites build theirs, and asks the rendered page.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'productivity-code-wrap-'));
const long = 'prompt = "Check if the response contains points mentioned from the grading notes and return pass or fail."';
// Three blocks, three shapes a theme can take. mkdocs-material scrolls an inner <code> and
// leaves the <pre> still; a plain <pre> scrolls itself, so its button has to be held in
// place against its own scrolling; and a short block has nothing to offer at all.
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 16px/1.5 system-ui; background: #fff; color: #111; }
  .highlight { width: 420px; margin: 20px; background: #f6f8fa; }
  .highlight pre { margin: 0; padding: 12px; }
  .highlight pre > code { display: block; overflow: auto; white-space: pre; font: 13px/1.6 monospace; }
  pre.own { width: 420px; margin: 20px; padding: 12px; overflow: auto; white-space: pre;
            background: #0d1117; color: #e6edf3; font: 13px/1.6 monospace; }
</style></head><body>
  <div class="highlight"><pre id="inner-scroller"><code tabindex="0">from ragas.metrics import DiscreteMetric
${long}
allowed_values=["pass", "fail"]</code><button id="copy" type="button">Copy</button></pre></div>
  <pre class="own" id="self-scroller"><code>${long}</code></pre>
  <div class="highlight"><pre id="short"><code tabindex="0">import os</code></pre></div>
</body></html>`;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(page);
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

  // Off until asked for, so the first page is the proof of that and nothing else.
  const before = await attach(`${origin}/`);
  await wait(500);
  const quiet = await evaluate(`document.querySelectorAll('.productivity-code-wrap-button').length`, before.sessionId);
  assert.equal(quiet, 0, 'with the switch untouched, no block is given a button');
  await call('Target.closeTarget', { targetId: before.targetId });

  await evaluate(`chrome.storage.local.set({ 'moduleEnabled:code-wrap': true })`);
  const view = await attach(`${origin}/`);
  await wait(600);

  const describe = `(id => {
    const block = document.getElementById(id);
    const button = block.querySelector('.productivity-code-wrap-button');
    const box = block.getBoundingClientRect();
    const corner = button?.getBoundingClientRect();
    const code = block.querySelector('code');
    return {
      button: !!button,
      state: block.getAttribute('data-productivity-wrap'),
      pressed: button?.getAttribute('aria-pressed'),
      label: button?.getAttribute('aria-label'),
      opacity: button && getComputedStyle(button).opacity,
      // Distance from the block's own top right corner, in CSS pixels.
      fromRight: corner && Math.round(box.right - corner.right),
      fromTop: corner && Math.round(corner.top - box.top),
      inside: corner ? corner.right <= box.right + 1 && corner.left >= box.left - 1 : null,
      overflow: Math.max(block.scrollWidth - block.clientWidth, code.scrollWidth - code.clientWidth),
      whiteSpace: getComputedStyle(code).whiteSpace,
      text: block.textContent
    };
  })`;
  const look = (id, session = view.sessionId) => evaluate(`${describe}(${JSON.stringify(id)})`, session);

  const short = await look('short');
  assert.equal(short.button, false, 'a block whose lines fit is left alone');
  assert.equal(short.state, null);

  for (const id of ['inner-scroller', 'self-scroller']) {
    const idle = await look(id);
    assert.equal(idle.button, true, `${id} must be offered the switch`);
    assert.equal(idle.state, 'off', 'a block starts unwrapped');
    assert.equal(idle.pressed, 'false');
    assert.equal(idle.label, 'Wrap long lines');
    assert.equal(idle.opacity, '0', 'the corner is empty until the block is hovered or focused');
    assert.ok(idle.overflow > 50, `${id} must be running off the edge to begin with`);
    assert.ok(idle.fromRight >= 0 && idle.fromRight < 40, `the button sits at ${id}'s right edge`);
    assert.ok(idle.fromTop >= 0 && idle.fromTop < 40, `the button sits at ${id}'s top`);
    assert.equal(idle.inside, true, 'and inside the block, not spilling past it');
  }

  // The corner only fills in when you are on the block, so that is worth asking the
  // renderer about rather than trusting the stylesheet to have said it.
  const centre = await evaluate(`(() => {
    const box = document.getElementById('inner-scroller').getBoundingClientRect();
    return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
  })()`, view.sessionId);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre[0], y: centre[1] }, view.sessionId);
  await wait(300);
  const hovered = await look('inner-scroller');
  assert.equal(hovered.opacity, '1', 'hovering the block brings its switch out');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }, view.sessionId);
  await wait(300);
  assert.equal((await look('inner-scroller')).opacity, '0', 'and leaving it puts the corner back');

  // A "copy code" button reads the block's text. Ours must not have added a word to it.
  const copied = await evaluate(`document.getElementById('inner-scroller').textContent.includes('Wrap')`, view.sessionId);
  assert.equal(copied, false, 'the label must stay out of the code the page would copy');

  // The claim itself: one click, and the lines fold instead of running off the edge.
  for (const id of ['inner-scroller', 'self-scroller']) {
    await evaluate(`document.getElementById(${JSON.stringify(id)}).querySelector('.productivity-code-wrap-button').click()`, view.sessionId);
  }
  await wait(200);
  for (const id of ['inner-scroller', 'self-scroller']) {
    const wrapped = await look(id);
    assert.equal(wrapped.state, 'on');
    assert.equal(wrapped.pressed, 'true');
    assert.equal(wrapped.label, 'Stop wrapping long lines');
    assert.equal(wrapped.whiteSpace, 'pre-wrap', `${id} must be wrapping, over the theme's own rule`);
    assert.equal(wrapped.overflow, 0, `${id} must have nothing left to scroll sideways`);
    assert.equal(wrapped.opacity, '1', 'a wrapped block keeps its switch in plain sight');
    assert.ok(wrapped.inside, 'the button stays inside the block it grew taller');
  }

  // Unwrapped again, and scrolled sideways: the button has to hold the visible corner
  // rather than ride the text off the edge.
  await evaluate(`document.getElementById('self-scroller').querySelector('.productivity-code-wrap-button').click()`, view.sessionId);
  await evaluate(`(() => { const block = document.getElementById('self-scroller'); block.scrollLeft = block.scrollWidth; block.dispatchEvent(new Event('scroll')); })()`, view.sessionId);
  await wait(200);
  const scrolled = await look('self-scroller');
  assert.equal(scrolled.state, 'off', 'the second click put the block back');
  assert.ok(scrolled.overflow > 50, 'and gave it its sideways scroll back');
  assert.ok(scrolled.fromRight >= 0 && scrolled.fromRight < 40 && scrolled.inside,
    `scrolled to the end, the button is still in the corner (${scrolled.fromRight}px from the right)`);

  // Switching the module off has to leave the page as it was found.
  await evaluate(`chrome.storage.local.set({ 'moduleEnabled:code-wrap': false })`);
  await wait(400);
  const after = await look('inner-scroller');
  assert.equal(after.button, false, 'every button is taken back');
  assert.equal(after.state, null, 'and so is every mark we left');
  assert.equal(after.whiteSpace, 'pre', "the theme's own wrapping rule is back in charge");
  const leftovers = await evaluate(`[
    document.querySelectorAll('.productivity-code-wrap-button').length,
    document.querySelectorAll('[data-productivity-wrap]').length,
    document.getElementById('productivity-code-wrap') ? 1 : 0,
    document.getElementById('inner-scroller').getAttribute('style') || ''
  ]`, view.sessionId);
  assert.deepEqual(leftovers, [0, 0, 0, ''], 'no buttons, no marks, no stylesheet, no inline position');
  assert.equal(await evaluate(`document.getElementById('copy').textContent`, view.sessionId), 'Copy',
    "the page's own button is untouched throughout");

  console.log('Code wrapping: off until enabled, then a button in the top right of each block whose lines run off the edge - held in the visible corner while the block scrolls, folding the lines on click over the theme\'s own white-space rule, without adding a word to the text the page would copy, and leaving nothing behind when switched off.');
} finally {
  socket?.close();
  server.close();
  browser.kill();
  await browserExit;
  await rm(profile, { recursive: true, force: true });
}
