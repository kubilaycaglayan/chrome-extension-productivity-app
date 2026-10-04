import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const coreRules = JSON.parse(await readFile(resolve(root, 'rules/easylist-ads.json'), 'utf8'));
const exceptionId = coreRules.find(rule => rule.action.type === 'allow' && rule.condition.urlFilter?.includes('2mdn.net/instream/html5/ima3.js') && rule.condition.initiatorDomains?.includes('zdnet.com'))?.id;
const siteRuleId = coreRules.find(rule => rule.action.type === 'block' && rule.condition.initiatorDomains?.includes('mega4upload.net') && rule.condition.resourceTypes?.includes('xmlhttprequest'))?.id;
assert.ok(exceptionId && siteRuleId);
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'productivity-ad-blocker-'));
const server = createServer(async (request, response) => {
  const filename = request.url === '/ad-blocker-video.mp4' ? 'ad-blocker-video.mp4' : 'ad-blocker.html';
  response.setHeader('Content-Type', filename.endsWith('.mp4') ? 'video/mp4' : 'text/html; charset=utf-8');
  response.end(await readFile(resolve(root, 'tests/fixtures', filename)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const localUrl = `http://127.0.0.1:${server.address().port}/ad-blocker.html`;
const browser = spawn(chromePath, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });
const browserExit = new Promise(resolve => browser.once('exit', resolve));
let socket;
let closed = false;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!port) throw new Error('Chrome DevTools did not start');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const call = (method, params = {}, sessionId) => new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const loaded = await call('Extensions.loadUnpacked', { path: root });
  if (loaded.error) throw new Error(JSON.stringify(loaded.error));
  const extensionId = loaded.result.id;
  const attach = async url => {
    const target = await call('Target.createTarget', { url });
    return (await call('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  };
  const popup = await attach(`chrome-extension://${extensionId}/popup/popup.html`);
  const page = await attach(localUrl);
  const evaluate = async (expression, sessionId = popup) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result.result.value;
  };
  const message = request => evaluate(`chrome.runtime.sendMessage(${JSON.stringify(request)})`);
  const outcome = (url, initiator, type = 'script') => evaluate(`chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url, initiator, type })})`);
  const ad = 'https://ad.doubleclick.net/pagead/ads';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  await wait(800);
  const state = await message({ type: 'ad-blocker:get' });
  assert.equal(state.enabled, true);
  // The domain-scoped host map is a static import, so a worker that cannot parse it
  // never answers at all; the popup names no tab, so its own host resolves to nothing.
  assert.deepEqual(state.cosmetic, []);
  assert.ok((await outcome(ad, localUrl)).matchedRules.some(rule => rule.rulesetId === 'easylist_ads'));
  assert.ok((await outcome('https://2mdn.net/instream/html5/ima3.js', 'https://zdnet.com')).matchedRules.some(rule => rule.ruleId === exceptionId));
  assert.ok((await outcome('https://files.example/x', 'https://mega4upload.net', 'xmlhttprequest')).matchedRules.some(rule => rule.ruleId === siteRuleId));

  const controls = await evaluate(`(async () => {
    const visible = id => getComputedStyle(document.getElementById(id)).display !== 'none';
    document.querySelector('#login input').value = 'demo';
    document.getElementById('login').requestSubmit();
    document.getElementById('checkout').click();
    document.getElementById('consent').click();
    const video = document.getElementById('video');
    await video.play();
    await new Promise(resolve => setTimeout(resolve, 350));
    return { ad: visible('ad-carousel'), article: visible('article'), nav: visible('navigation'),
      login: visible('login'), checkout: visible('checkout'), consent: visible('consent'),
      actions: fixtureActions, videoTime: video.currentTime };
  })()`, page);
  // #ad-carousel is a generic selector that one host cancels, so the frame assembles it
  // into its own adopted stylesheet: this is the whole cosmetic path the content script
  // still owns. The generic stylesheet behind #AdBox2 is registered in phase 5 of
  // plans/cosmetic-filtering-performance.md and gets its own check there.
  assert.equal(controls.ad, false);
  for (const key of ['article', 'nav', 'login', 'checkout', 'consent']) assert.equal(controls[key], true);
  assert.deepEqual(controls.actions, { login: 1, checkout: 1, consent: 1 });
  assert.ok(controls.videoTime > 0);

  assert.equal((await message({ type: 'ad-blocker:set-sites', sites: ['127.0.0.1'] })).ok, true);
  await wait(250);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('ad-carousel')).display", page), 'block');
  assert.ok((await outcome(ad, localUrl)).matchedRules.some(rule => rule.rulesetId === '_dynamic'));
  assert.equal((await message({ type: 'ad-blocker:set-sites', sites: [] })).ok, true);
  assert.equal((await message({ type: 'ad-blocker:set-enabled', enabled: false })).enabled, false);
  await wait(250);
  assert.deepEqual((await outcome(ad, localUrl)).matchedRules, []);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('ad-carousel')).display", page), 'block');
  // Simulate Chrome resetting the manifest-enabled core during an extension update.
  await evaluate("chrome.declarativeNetRequest.updateEnabledRulesets({enableRulesetIds:['easylist_ads']})");
  await call('ServiceWorker.enable', {}, popup);
  await call('ServiceWorker.stopAllWorkers', {}, popup);
  await wait(300);
  const woken = await message({ type: 'ad-blocker:get' });
  assert.equal(woken.enabled, false);
  assert.deepEqual(woken.cosmetic, []);
  assert.deepEqual(await evaluate('chrome.declarativeNetRequest.getEnabledRulesets()'), []);
  assert.equal((await message({ type: 'ad-blocker:set-enabled', enabled: true })).enabled, true);
  await wait(250);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('ad-carousel')).display", page), 'none');
  console.log('PASS Chrome loaded the rules, matched block/exception/site rules, paused a site, reconciled after a worker restart, toggled globally, and kept page controls and video working.');
  await call('Browser.close');
  closed = true;
} finally {
  socket?.close();
  if (!closed) browser.kill('SIGTERM');
  await Promise.race([browserExit, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (browser.exitCode === null) browser.kill('SIGKILL');
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
