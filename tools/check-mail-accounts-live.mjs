// What the Gmail shortcuts claim needs a real browser to check. Two things, neither of
// which node can answer:
//
//   * the buttons are where they say they are -- fixed in the top right corner, drawn,
//     and the thing a click at that point actually hits, not covered by the scrim, the
//     background chooser or the page content stacked around them;
//   * Gmail answers the probe the discovery is built on. A HEAD request with cookies,
//     sent from the extension's own origin, has to come back with the URL it ended up on
//     rather than a CORS error -- and in a fresh profile, signed out of everything, that
//     URL must be the login page, which is exactly how the worker reads "nobody here".
//
// Signed-in detection itself cannot be checked here: a temporary profile has no Google
// account. What is checked is the predicate both answers run through.
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
          badge: link.querySelector('.mail-index')?.textContent ?? null,
          box: { top: box.top, right: box.right, width: box.width, height: box.height },
          painted: getComputedStyle(link).backgroundColor,
          topRight: box.top < view.height / 2 && box.right > view.width / 2,
          hit: centre === link || link.contains(centre),
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
  assert.equal(fresh.links[0].badge, null, 'one account has nothing to be told apart from');
  assert.ok(fresh.links[0].topRight, `the shortcut must sit in the top right, not at ${JSON.stringify(fresh.links[0].box)}`);
  assert.ok(fresh.links[0].box.top >= 0 && fresh.links[0].box.right <= fresh.view.width, 'and inside the window');
  assert.equal(Math.round(fresh.links[0].box.width), 42);
  assert.ok(fresh.links[0].hit, 'a click in the middle of the button must reach the link');
  assert.notEqual(fresh.links[0].painted, 'rgba(0, 0, 0, 0)', 'an unpainted button is an invisible button');

  /* The question the discovery actually asks Gmail. Signed out of everything, every
     index has to come back pointing somewhere that is not itself. */
  const probe = await evaluate(`(async () => {
    const landings = [];
    for (const slot of [0, 1]) {
      try {
        const response = await fetch(\`https://mail.google.com/mail/u/\${slot}/\`, {
          method: 'HEAD', credentials: 'include', cache: 'no-store', redirect: 'follow'
        });
        landings.push({ slot, status: response.status, url: response.url });
      } catch (error) {
        landings.push({ slot, error: String(error) });
      }
    }
    return landings;
  })()`);
  for (const landing of probe) {
    assert.ok(!landing.error, `a HEAD to Gmail from the extension must be allowed, not ${landing.error}`);
    assert.ok(landing.url, 'the probe must learn where it ended up');
    const signedIn = new URL(landing.url).origin === 'https://mail.google.com'
      && new RegExp(`^/mail/u/${landing.slot}(/|$)`).test(new URL(landing.url).pathname);
    assert.equal(signedIn, false, `a profile with no Google account must not read as signed in: ${landing.url}`);
  }
  assert.ok(probe.some(landing => new URL(landing.url).host === 'accounts.google.com'),
    `Gmail is expected to bounce a signed-out probe to the account pages, not ${JSON.stringify(probe)}`);

  /* And the worker's own run of that walk, which starts on install. Signed out, it
     stores an empty list -- the page's single-shortcut case, not a page with no
     shortcut. Everything after this seeds the list by hand, so it has to wait for the
     real probe to have had its say first. */
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
  assert.deepEqual(stored.newtabMailAccounts?.accounts, [], `the install probe must record what it found, got ${JSON.stringify(stored)}`);
  assert.ok(Date.now() - stored.newtabMailAccounts.checkedAt < 300_000, 'and stamp it');
  await wait(400);
  const signedOut = await buttons();
  assert.equal(signedOut.links.length, 1, 'an empty list is one plain Gmail button, never none');
  assert.equal(signedOut.links[0].badge, null);

  /* Two accounts discovered: a button each, numbered, both still reachable, and all of
     it live on the page that was already open. */
  await evaluate(`chrome.storage.local.set({ newtabMailAccounts: { accounts: [0, 1], checkedAt: Date.now() } })`);
  await wait(300);
  const two = await buttons();
  assert.equal(two.links.length, 2, 'an account found while the tab is open must appear without a reload');
  assert.deepEqual(two.links.map(link => link.href), [
    'https://mail.google.com/mail/u/0/',
    'https://mail.google.com/mail/u/1/'
  ]);
  assert.deepEqual(two.links.map(link => link.badge), ['1', '2']);
  assert.deepEqual(two.links.map(link => link.label), ['Gmail \u2014 account 1', 'Gmail \u2014 account 2']);
  for (const link of two.links) {
    assert.ok(link.topRight && link.hit, `${link.label} must be in the corner and clickable: ${JSON.stringify(link)}`);
    assert.ok(link.iconDrawn, `${link.label} must paint its envelope, not a broken image`);
  }
  assert.ok(two.links[1].box.right > two.links[0].box.right, 'account 2 sits to the right of account 1');
  assert.ok(two.links[1].box.right - two.links[0].box.right >= 42, 'the buttons must not overlap each other');

  /* On a window narrow enough for the centred page to reach the fixed corner, the tab
     group chips have to stop short of the buttons -- by one button's width per account,
     which is a cascade that only a browser can be asked to resolve. */
  const room = async width => {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 0, mobile: false }, newtab);
    await wait(200);
    return evaluate(`getComputedStyle(document.getElementById('tab-groups')).right`);
  };
  assert.equal(await room(1000), '108px', 'two accounts must hold two buttons of room for the chips');
  await evaluate(`chrome.storage.local.set({ newtabMailAccounts: { accounts: [0], checkedAt: Date.now() } })`);
  await wait(300);
  assert.equal(await room(1000), '54px', 'and one account one');
  assert.equal(await room(1400), '0px', 'a window with space to spare leaves the chips centred');
  await call('Emulation.clearDeviceMetricsOverride', {}, newtab);
  await evaluate(`chrome.storage.local.set({ newtabMailAccounts: { accounts: [0, 1], checkedAt: Date.now() } })`);
  await wait(300);

  /* The chooser opens in the opposite corner but is the page's topmost layer; it must
     not end up covering these buttons. */
  await evaluate(`document.getElementById('background-toggle').click()`);
  await wait(200);
  const withPanel = await buttons();
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

  console.log('PASS Chrome drew the Gmail shortcuts in the top right corner, kept them clickable beside the open chooser, numbered one button per discovered account live, and let the worker ask Gmail where each index lands.');
  await call('Browser.close');
  closed = true;
} finally {
  socket?.close();
  if (!closed) browser.kill('SIGTERM');
  await Promise.race([browserExit, new Promise(done => setTimeout(done, 5000))]);
  if (browser.exitCode === null) browser.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
