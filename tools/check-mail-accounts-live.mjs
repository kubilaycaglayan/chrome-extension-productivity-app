// What the Gmail shortcuts claim needs a real browser to check. Two things, neither of
// which node can answer:
//
//   * the buttons are where they say they are -- a column fixed in the top right corner,
//     each wearing its email, drawn, and the thing a click at that point actually hits,
//     not covered by the scrim, the background chooser or the page content around them;
//   * Google answers the request the discovery is built on. A cookie-bearing POST to
//     accounts.google.com/ListAccounts from the extension is refused while it carries
//     the chrome-extension:// Origin; with the worker's session rule stripping it, a
//     fresh profile signed out of everything gets the list back, empty.
//
// Signed-in detection itself cannot be checked here: a temporary profile has no Google
// account. tests/mail-accounts.test.cjs holds the parser to the signed-in shape.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'productivity-mail-accounts-'));
const browser = spawn(chromePath, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1280,800',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });
const browserExit = new Promise(done => browser.once('exit', done));
let socket;
let closed = false;
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
  const loaded = await call('Extensions.loadUnpacked', { path: root });
  if (loaded.error) throw new Error(JSON.stringify(loaded.error));
  const extensionId = loaded.result.id;
  const attach = async url => {
    const target = await call('Target.createTarget', { url });
    return (await call('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  };
  const wait = ms => new Promise(done => setTimeout(done, ms));
  const newtab = await attach(`chrome-extension://${extensionId}/newtab/newtab.html`);
  const evaluate = async (expression, sessionId = newtab) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result.result.value;
  };

  // Reads every button the way a pointer would: where it is, whether it is painted, and
  // what a click at its centre would land on.
  const buttons = () => evaluate(`(() => {
    const row = document.getElementById('mail-links');
    const view = { width: innerWidth, height: innerHeight };
    // The page may still be arriving when the first read lands.
    if (!row) return { hidden: true, view, links: [] };
    return {
      hidden: row.hidden,
      view,
      links: [...row.querySelectorAll('a.mail-link')].map(link => {
        const box = link.getBoundingClientRect();
        const centre = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        const icon = link.querySelector('.mail-icon');
        return {
          href: link.href,
          label: link.getAttribute('aria-label'),
          email: link.querySelector('.mail-email')?.textContent ?? null,
          box: { top: box.top, right: box.right, width: box.width, height: box.height },
          painted: getComputedStyle(link).backgroundColor,
          topRight: box.top < view.height / 2 && box.right > view.width / 2,
          hit: centre === link || link.contains(centre),
          toggle: link.parentElement.querySelector('.mail-toggle')?.textContent ?? null,
          dimmed: getComputedStyle(link).opacity !== '1',
          iconDrawn: Boolean(icon) && icon.complete && icon.naturalWidth > 0
        };
      })
    };
  })()`);

  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await buttons()).links.length) break;
    await wait(100);
  }

  /* A profile with nothing discovered yet: one plain shortcut to the first account. */
  const fresh = await buttons();
  assert.equal(fresh.hidden, false);
  assert.equal(fresh.links.length, 1, 'a page with no account list still offers Gmail');
  assert.equal(fresh.links[0].href, 'https://mail.google.com/mail/u/0/');
  assert.equal(fresh.links[0].label, 'Gmail');
  assert.equal(fresh.links[0].email, null, 'with no account known there is no email to show');
  assert.ok(fresh.links[0].topRight, `the shortcut must sit in the top right, not at ${JSON.stringify(fresh.links[0].box)}`);
  assert.ok(fresh.links[0].box.top >= 0 && fresh.links[0].box.right <= fresh.view.width, 'and inside the window');
  assert.equal(Math.round(fresh.links[0].box.width), 42);
  assert.ok(fresh.links[0].hit, 'a click in the middle of the button must reach the link');
  assert.notEqual(fresh.links[0].painted, 'rgba(0, 0, 0, 0)', 'an unpainted button is an invisible button');

  /* The question the discovery actually asks Google. From the extension's origin, as is,
     it is refused -- which is why the worker strips the Origin first. */
  const listAccounts = () => evaluate(`(async () => {
    try {
      const response = await fetch('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', {
        method: 'POST', body: ' ', credentials: 'include', cache: 'no-store'
      });
      return { status: response.status, body: (await response.text()).slice(0, 200) };
    } catch (error) {
      return { error: String(error) };
    }
  })()`);

  /* And the worker's own run, which starts on install: it installs the rule, asks, and
     signed out stores an empty list -- the page's single-shortcut case, not a page with
     no shortcut. Everything after this seeds the list by hand, so it has to wait for the
     real answer to have had its say first. */
  const worker = (await call('Target.getTargets')).result.targetInfos
    .find(target => target.type === 'service_worker' && target.url.includes(extensionId));
  assert.ok(worker, 'the service worker must be running');
  const workerSession = (await call('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).result.sessionId;
  let stored;
  for (let attempt = 0; attempt < 150; attempt++) {
    stored = await evaluate(`chrome.storage.local.get('newtabMailAccounts')`, workerSession);
    if (stored.newtabMailAccounts) break;
    await wait(200);
  }
  assert.deepEqual(stored.newtabMailAccounts?.accounts, [], `the install run must record what it found, got ${JSON.stringify(stored)}`);
  assert.ok(Date.now() - stored.newtabMailAccounts.checkedAt < 300_000, 'and stamp it');
  const rules = await evaluate(`chrome.declarativeNetRequest.getSessionRules()`, workerSession);
  assert.ok(rules.some(rule => rule.condition.urlFilter === '|https://accounts.google.com/ListAccounts'), 'the Origin rule must be in place');
  const allowed = await listAccounts();
  assert.equal(allowed.status, 200, `with the rule, Google must answer: ${JSON.stringify(allowed)}`);
  assert.equal(allowed.body, '["gaia.l.a.r",[]]', 'a signed-out profile is an empty list');
  await evaluate(`chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ${JSON.stringify(rules.map(rule => rule.id))} })`, workerSession);
  const refused = await listAccounts();
  assert.notEqual(refused.status, 200, 'without it Google refuses the extension -- if this passes, the rule may be dead weight');
  await wait(400);
  const signedOut = await buttons();
  assert.equal(signedOut.links.length, 1, 'an empty list is one plain Gmail button, never none');
  assert.equal(signedOut.links[0].email, null);

  /* Two accounts signed in: a row each, top to bottom, each wearing its email and
     clickable, all of it live on the page that was already open. */
  const seed = list => evaluate(`chrome.storage.local.set({ newtabMailAccounts: { accounts: ${JSON.stringify(list)}, checkedAt: Date.now() } })`);
  const work = { email: 'someone.with.a.long.address@example.com', name: 'Work' };
  const me = { email: 'me@gmail.com' };
  await seed([work, me]);
  await wait(300);
  const two = await buttons();
  assert.equal(two.links.length, 2, 'an account found while the tab is open must appear without a reload');
  assert.deepEqual(two.links.map(link => link.href), [
    'https://mail.google.com/mail/?authuser=someone.with.a.long.address%40example.com',
    'https://mail.google.com/mail/?authuser=me%40gmail.com'
  ]);
  assert.deepEqual(two.links.map(link => link.email), ['someone.with.a.long.address', 'me'], 'a button reads the username');
  for (const link of two.links) {
    assert.ok(link.topRight && link.hit, `${link.label} must be in the corner and clickable: ${JSON.stringify(link)}`);
    assert.ok(link.iconDrawn, `${link.label} must paint its envelope, not a broken image`);
  }
  assert.ok(Math.abs(two.links[0].box.right - two.links[1].box.right) <= 1, 'the column lines up on its right edge');
  assert.ok(two.links[1].box.top >= two.links[0].box.top + two.links[0].box.height, 'the second account sits below the first, not over it');

  /* Hiding: edit mode lays a switch beside each account; a hidden one waits there,
     dimmed, and is gone once editing is done. */
  await evaluate(`document.getElementById('edit-toggle').click()`);
  await wait(100);
  let editing = await buttons();
  assert.deepEqual(editing.links.map(link => link.toggle), ['Hide', 'Hide']);
  await evaluate(`document.querySelectorAll('.mail-toggle')[1].click()`);
  await wait(300);
  editing = await buttons();
  assert.equal(editing.links[1].toggle, 'Show');
  assert.ok(editing.links[1].dimmed, 'a hidden account is dimmed while editing');
  assert.ok(editing.links.every(link => link.hit), 'the switches must not cover the links');
  assert.deepEqual((await evaluate(`chrome.storage.local.get('newtabMailHidden')`)).newtabMailHidden, ['me@gmail.com']);
  await evaluate(`document.getElementById('edit-toggle').click()`);
  await wait(100);
  assert.deepEqual((await buttons()).links.map(link => link.email), ['someone.with.a.long.address'], 'done editing, the hidden account is gone');
  await evaluate(`chrome.storage.local.set({ newtabMailHidden: [] })`);
  await wait(300);

  /* On a window narrow enough for the centred page to reach the fixed corner, the tab
     group chips have to stop short of the column -- however wide its emails make it,
     which is a cascade only a browser can be asked to resolve. */
  const room = async width => {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 0, mobile: false }, newtab);
    await wait(200);
    // A fresh profile has no tab groups, so the row is shown with a stand-in chip
    // for the measurement: hidden, it has no used position to read.
    return evaluate(`(() => {
      const row = document.getElementById('tab-groups');
      if (!row.children.length) row.innerHTML = '<button class="tab-group-chip">A stand-in tab group with a long title</button>';
      row.hidden = false;
      const chips = row.getBoundingClientRect();
      const column = document.getElementById('mail-links').getBoundingClientRect();
      return { right: getComputedStyle(document.getElementById('tab-groups')).right, gap: column.left - chips.right };
    })()`);
  };
  const narrow = await room(1100);
  assert.notEqual(narrow.right, '0px', 'a narrow window must hold room for the column');
  assert.ok(narrow.gap >= 0, `the chips must end before the column starts, not ${narrow.gap}px into it`);
  const wide = await room(1900);
  assert.equal(wide.right, '0px', `a window with space to spare leaves the chips centred: ${JSON.stringify(wide)}`);
  await call('Emulation.clearDeviceMetricsOverride', {}, newtab);

  /* The chooser opens below the column but is the page's topmost layer; however long
     the column runs, it must not end up covering these buttons. */
  await seed(Array.from({ length: 6 }, (_, n) => ({ email: `account${n}@example.com` })));
  await wait(300);
  await evaluate(`document.getElementById('background-toggle').click()`);
  await wait(200);
  const withPanel = await buttons();
  assert.equal(withPanel.links.length, 6);
  for (const link of withPanel.links) {
    assert.ok(link.hit, 'the open chooser must not cover the Gmail buttons');
  }
  await evaluate(`document.getElementById('background-toggle').click()`);

  /* Switching the module off must leave no floating button behind. */
  await evaluate(`chrome.storage.local.set({ 'moduleEnabled:newtab': false })`);
  await wait(400);
  const off = await buttons();
  assert.equal(off.hidden, true, 'a disabled page must take its corner with it');
  assert.equal(off.links.length, 0);

  console.log('PASS Chrome drew the Gmail column in the top right corner with each account\'s email, kept it clickable beside the open chooser, hid and showed accounts from edit mode, kept the chips clear of it, and let the worker read ListAccounts past the Origin Google refuses.');
  await call('Browser.close');
  closed = true;
} finally {
  socket?.close();
  if (!closed) browser.kill('SIGTERM');
  await Promise.race([browserExit, new Promise(done => setTimeout(done, 5000))]);
  if (browser.exitCode === null) browser.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
