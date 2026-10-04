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
  const evaluate = async (expression, sessionId = popup) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result.result.value;
  };
  const message = request => evaluate(`chrome.runtime.sendMessage(${JSON.stringify(request)})`);
  const outcome = (url, initiator, type = 'script') => evaluate(`chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url, initiator, type })})`);
  const ad = 'https://ad.doubleclick.net/pagead/ads';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const registrations = () => evaluate('chrome.scripting.getRegisteredContentScripts()');
  const registeredIds = async () => (await registrations()).map(script => script.id).sort();
  // The cosmetic layer is registered by the service worker rather than declared in the
  // manifest, so a page opened before the worker has run would carry no cosmetic filtering
  // at all. Every page below is opened after the registration is confirmed present.
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await message({ type: 'ad-blocker:get' }).catch(() => null);
    if (state?.ok && (await registeredIds()).includes('ad-blocker-generic')) break;
    await wait(100);
  }
  assert.equal(state?.enabled, true);
  // The domain-scoped host map is a static import, so a worker that cannot parse it
  // never answers at all; the popup names no tab, so its own host resolves to nothing.
  assert.deepEqual(state.cosmetic, []);
  assert.deepEqual(await registeredIds(), ['ad-blocker-cosmetic', 'ad-blocker-generic']);
  const genericScript = (await registrations()).find(script => script.id === 'ad-blocker-generic');
  assert.deepEqual(genericScript.css, ['content/ad-blocker-generic.css']);
  assert.equal(genericScript.allFrames, true);
  assert.equal(genericScript.runAt, 'document_start');
  assert.ok(!genericScript.excludeMatches?.length);
  const page = await attach(localUrl);
  assert.ok((await outcome(ad, localUrl)).matchedRules.some(rule => rule.rulesetId === 'easylist_ads'));
  assert.ok((await outcome('https://2mdn.net/instream/html5/ima3.js', 'https://zdnet.com')).matchedRules.some(rule => rule.ruleId === exceptionId));
  assert.ok((await outcome('https://files.example/x', 'https://mega4upload.net', 'xmlhttprequest')).matchedRules.some(rule => rule.ruleId === siteRuleId));

  // A registered stylesheet applies from the next navigation, not to a page already open, so
  // every pause and toggle below is read on the page that was already there and on a page
  // opened afterwards. The fresh page also reports what was already hidden before paint.
  const openFixture = async () => {
    const target = (await call('Target.createTarget', { url: localUrl })).result.targetId;
    const session = (await call('Target.attachToTarget', { targetId: target, flatten: true })).result.sessionId;
    await wait(700);
    const spaces = await evaluate(`({ early: fixtureEarly,
      adBox: getComputedStyle(document.getElementById('AdBox2')).display,
      carousel: getComputedStyle(document.getElementById('ad-carousel')).display })`, session);
    await call('Target.closeTarget', { targetId: target });
    return spaces;
  };
  const display = id => evaluate(`getComputedStyle(document.getElementById('${id}')).display`, page);

  const active = await openFixture();
  // #AdBox2 is a generic EasyList hide carried by the registered stylesheet, so it is
  // already hidden while the parser is inside <body> and nothing has painted. That is the
  // whole point of registering the sheet instead of building it in the frame.
  assert.equal(active.early.paints, 0);
  assert.equal(active.early.adBox, 'none');
  assert.equal(active.adBox, 'none');
  // #ad-carousel is a generic selector one host cancels, so it cannot sit in the static
  // sheet; the frame assembles it after asking the service worker, which is why it is still
  // visible at the pre-paint reading and hidden by the time the page settles.
  assert.equal(active.early.adCarousel, 'block');
  assert.equal(active.carousel, 'none');

  const controls = await evaluate(`(async () => {
    const visible = id => getComputedStyle(document.getElementById(id)).display !== 'none';
    document.querySelector('#login input').value = 'demo';
    document.getElementById('login').requestSubmit();
    document.getElementById('checkout').click();
    document.getElementById('consent').click();
    const video = document.getElementById('video');
    await video.play();
    await new Promise(resolve => setTimeout(resolve, 350));
    return { ad: visible('ad-carousel'), adBox: visible('AdBox2'), article: visible('article'),
      nav: visible('navigation'), login: visible('login'), checkout: visible('checkout'),
      consent: visible('consent'), actions: fixtureActions, videoTime: video.currentTime };
  })()`, page);
  assert.equal(controls.ad, false);
  assert.equal(controls.adBox, false);
  for (const key of ['article', 'nav', 'login', 'checkout', 'consent']) assert.equal(controls[key], true);
  assert.deepEqual(controls.actions, { login: 1, checkout: 1, consent: 1 });
  assert.ok(controls.videoTime > 0);

  assert.equal((await message({ type: 'ad-blocker:set-sites', sites: ['127.0.0.1'] })).ok, true);
  await wait(250);
  // The frame drops its own sheet at once; the registered stylesheet is excluded from the
  // next navigation, which is the reload the popup asks the user for.
  assert.equal(await display('ad-carousel'), 'block');
  assert.deepEqual((await registrations()).find(script => script.id === 'ad-blocker-generic').excludeMatches, ['*://127.0.0.1/*']);
  const paused = await openFixture();
  assert.equal(paused.adBox, 'block');
  assert.equal(paused.carousel, 'block');
  assert.ok((await outcome(ad, localUrl)).matchedRules.some(rule => rule.rulesetId === '_dynamic'));
  assert.equal((await message({ type: 'ad-blocker:set-sites', sites: [] })).ok, true);
  assert.equal((await message({ type: 'ad-blocker:set-enabled', enabled: false })).enabled, false);
  await wait(250);
  assert.deepEqual((await outcome(ad, localUrl)).matchedRules, []);
  assert.equal(await display('ad-carousel'), 'block');
  // Disabled, the stylesheet is unregistered, since a frame cannot take injected CSS back
  // off. The per-host script stays registered so an open frame can restore its own sheet.
  assert.deepEqual(await registeredIds(), ['ad-blocker-cosmetic']);
  const off = await openFixture();
  assert.equal(off.adBox, 'block');
  assert.equal(off.carousel, 'block');
  // Simulate Chrome resetting the manifest-enabled core during an extension update.
  await evaluate("chrome.declarativeNetRequest.updateEnabledRulesets({enableRulesetIds:['easylist_ads']})");
  await call('ServiceWorker.enable', {}, popup);
  await call('ServiceWorker.stopAllWorkers', {}, popup);
  await wait(300);
  const woken = await message({ type: 'ad-blocker:get' });
  assert.equal(woken.enabled, false);
  assert.deepEqual(woken.cosmetic, []);
  assert.deepEqual(await evaluate('chrome.declarativeNetRequest.getEnabledRulesets()'), []);
  // A registration persists across a worker restart, so the wake must not add a second one
  // or leave the disabled preference contradicted.
  assert.deepEqual(await registeredIds(), ['ad-blocker-cosmetic']);
  assert.equal((await message({ type: 'ad-blocker:set-enabled', enabled: true })).enabled, true);
  await wait(250);
  assert.equal(await display('ad-carousel'), 'none');
  assert.deepEqual(await registeredIds(), ['ad-blocker-cosmetic', 'ad-blocker-generic']);
  const resumed = await openFixture();
  assert.equal(resumed.early.paints, 0);
  assert.equal(resumed.early.adBox, 'none');
  assert.equal(resumed.carousel, 'none');
  console.log('PASS Chrome loaded the rules, hid a generic ad space before first paint, matched block/exception/site rules, paused a site, reconciled registrations and rules after a worker restart, toggled globally, and kept page controls and video working.');
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
