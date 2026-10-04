// Benchmark for the cosmetic ad-blocking layer of plans/cosmetic-filtering-performance.md.
// Loads tests/fixtures/cosmetic-bench.html with two same-origin and three cross-origin
// frames in headless Chrome over CDP, and records the three numbers the plan is judged on:
// script evaluation time attributed to the cosmetic content script, time to first paint,
// and total style recalculation. The same command produced the plan's before and after
// columns; the before run is the commit in which phase 1 added this file.
//
// Three scenarios run against the same fixture so the result is interpretable: no extension
// at all (the floor), the cosmetic layer active (the number the plan moves), and the
// benchmark host paused. Pausing is no longer a clean floor: the service worker hands no
// frame any selectors, and the registration excludes the paused host's own documents, but an
// excludeMatches pattern is matched against each frame's own URL rather than the top frame's,
// so the two cross-site frames in the fixture still get the generic stylesheet and still pay
// for it in style recalculation. The assertions below pin that down rather than hide it.
//
// One cost cannot be read out of the page: update() runs in the promise callback of the
// ad-blocker:get response, and Chrome attributes that work to neither a trace event nor
// Performance.ScriptDuration, so the scenarios above see only its effect on style
// recalculation. The benchmark therefore times that stage directly, running a replica of it
// over the shipped artifacts in a page's main world, and checks the selector count the
// replica produces against the sheet the content script actually adopted, read from the
// content script's own isolated world.
//
//   node tools/bench-cosmetic.mjs [--runs=3] [--out=path.json]
//
// Needs Node 22+ for a global WebSocket, and Chrome and openssl installed; set CHROME_PATH
// for a nonstandard Chrome location.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
// Names the isolated world the content script runs in, so the sheet it adopts can be found.
const extensionName = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')).name;
const options = new Map(process.argv.slice(2).map(argument => {
  const [name, value = ''] = argument.replace(/^--/, '').split('=');
  return [name, value];
}));
const runs = Number(options.get('runs') || 3);
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
const outPath = options.get('out');
// Long enough for the ad-blocker:get round trip and the injection it gates to finish in
// every frame, and identical across scenarios so the recorded totals stay comparable.
const SETTLE = 1500;

// The host the fixture is written against: screenrant.com carries five domain-scoped
// EasyList selectors and excepts four generic ones, so one fixture exercises every path a
// selector can now reach a frame by.
const TOP_HOST = 'screenrant.com';
const FRAME_HOSTS = [TOP_HOST, TOP_HOST, `static.${TOP_HOST}`, 'bench-frame-one.test', 'bench-frame-two.test'];
const PROBES = {
  // Carried by the registered stylesheet, so hidden before the page's first paint.
  genericId: '#AD_300',
  genericAttribute: '[data-ad-module]',
  genericCombinator: '.banner-img > .pbl',
  // Resolved for this host by the service worker and sent on the ad-blocker:get response.
  hostScoped: '.ad-zone-sidebar-default',
  // A generic selector some other host cancels, so it cannot sit in the static stylesheet
  // and the frame has to assemble it: the one cosmetic decision still made per frame.
  exceptedElsewhere: '#ad-carousel',
  // Cancelled on this host, so it stays visible however it arrived.
  exceptedOnHost: '.ad-current',
  content: '#article'
};
// Kept in step with content/ad-blocker.js, so the timed replica of its assembly stage can
// be checked against the sheet the content script really adopted.
const matches = (site, domain) => site === domain || site.endsWith(`.${domain}`);
const applies = (domains, site) => {
  const positives = domains.filter(domain => !domain.startsWith('~'));
  return (!positives.length || positives.some(domain => matches(site, domain))) &&
    !domains.some(domain => domain.startsWith('~') && matches(site, domain.slice(1)));
};

// What a frame loads, and what it no longer loads. The host map is read here the way the
// service worker reads it, through the same resolver, so the selector set the replica below
// is checked against is the one the extension would really send.
const exceptedSource = await readFile(resolve(root, 'content/ad-blocker-excepted.js'), 'utf8');
const excepted = JSON.parse(exceptedSource.match(/^globalThis\.adBlockerExcepted = (.*);$/m)[1]);
const contentScriptSource = await readFile(resolve(root, 'content/ad-blocker.js'), 'utf8');
const genericCss = await readFile(resolve(root, 'content/ad-blocker-generic.css'), 'utf8');
// One display:none rule per line, each grouping a bounded number of selectors; see the
// CSSSelector entry limit in tools/ad-blocker-build/cosmetic.mjs.
const genericRules = [...genericCss.matchAll(/^([^{}]+)\{display:none!important\}$/gm)].map(match => match[1].split(','));
const genericSelectors = genericRules.flat();
const domainRulesPath = resolve(root, 'content/ad-blocker-domain-rules.js');
const domainRules = await import(pathToFileURL(domainRulesPath));
const { resolveCosmetic } = await import(pathToFileURL(resolve(root, 'modules/ad-blocker.js')));
const hostScoped = resolveCosmetic(domainRules, TOP_HOST);
// The frame's whole computation, replicated from content/ad-blocker.js.
const hostCancelled = new Set(excepted.filter(entry => applies(entry.d, TOP_HOST)).map(entry => entry.s));
const frameSelectors = [...new Set([...excepted.map(entry => entry.s), ...hostScoped])].filter(selector => !hostCancelled.has(selector));
const artifacts = {
  host: TOP_HOST,
  perFrameBytes: Buffer.byteLength(exceptedSource) + Buffer.byteLength(contentScriptSource),
  perFrameFiles: {
    'content/ad-blocker-excepted.js': { bytes: Buffer.byteLength(exceptedSource), entries: excepted.length },
    'content/ad-blocker.js': { bytes: Buffer.byteLength(contentScriptSource) }
  },
  generic: { file: 'content/ad-blocker-generic.css', bytes: Buffer.byteLength(genericCss), rules: genericRules.length, selectors: genericSelectors.length },
  // Pulled in by the service worker once per wake, never by a frame.
  serviceWorker: { file: 'content/ad-blocker-domain-rules.js', bytes: (await readFile(domainRulesPath)).byteLength },
  hostScoped: hostScoped.length,
  frameAssembled: frameSelectors.length,
  supportsCallsPerFrame: 0,
  styleElementsPerFrame: 0
};

const fixture = await readFile(resolve(root, 'tests/fixtures/cosmetic-bench.html'), 'utf8');
const placeholder = '<!--bench:frames-->';
assert.ok(fixture.includes(placeholder), 'fixture lost its frame placeholder');
const frameMarkup = FRAME_HOSTS
  .map((host, index) => `<iframe title="Frame ${index + 1}" src="https://${host}/frame" width="320" height="240"></iframe>`)
  .join('\n  ');
// The fixture is served over HTTPS under the real EasyList hostnames it is written against,
// because Chrome's HSTS preload list refuses plain HTTP for them and the fallback it would
// otherwise take would land in the paint timings. The certificate is self-signed and thrown
// away with the run; Chrome is launched with certificate errors ignored.
const hosts = [...new Set([TOP_HOST, ...FRAME_HOSTS])];
const certDir = await mkdtemp(join(tmpdir(), 'productivity-bench-cert-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=cosmetic-bench',
  '-addext', `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}`,
  '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')
], { stdio: 'ignore' });
const credentials = { key: await readFile(join(certDir, 'key.pem')), cert: await readFile(join(certDir, 'cert.pem')) };
const server = createServer(credentials, (request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(fixture.replace(placeholder, request.url.startsWith('/frame') ? '' : frameMarkup));
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const { port } = server.address();
const topUrl = `https://${TOP_HOST}/`;

const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'productivity-bench-cosmetic-'));
const resolverRules = hosts.map(host => `MAP ${host} 127.0.0.1:${port}`).join(',');
const browser = spawn(chromePath, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-background-networking', '--disable-component-update', '--ignore-certificate-errors',
  `--host-resolver-rules=${resolverRules}`,
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });
const browserExit = new Promise(exited => browser.once('exit', exited));
const wait = ms => new Promise(done => setTimeout(done, ms));
let socket;
let closed = false;
try {
  let debuggerPort;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { debuggerPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await wait(100); }
  }
  if (!debuggerPort) throw new Error('Chrome DevTools did not start');
  const version = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((open, fail) => { socket.onopen = open; socket.onerror = fail; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
    for (const listener of [...listeners]) listener(message);
  };
  const call = (method, params = {}, sessionId) => new Promise(done => {
    const id = ++nextId;
    pending.set(id, done);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const on = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const once = (method, sessionId) => new Promise(done => {
    const off = on(message => {
      if (message.method !== method || (sessionId && message.sessionId !== sessionId)) return;
      off();
      done(message);
    });
  });
  const evaluate = async (expression, sessionId, contextId) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
    if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result.result.value;
  };

  // Tracing is browser wide, so it is started around a single navigation and ended before
  // anything is read back out of the page, keeping the collectors out of the measurement.
  async function traced(body) {
    const events = [];
    const off = on(message => {
      if (message.method === 'Tracing.dataCollected') events.push(...message.params.value);
    });
    await call('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['devtools.timeline', 'blink.user_timing', 'loading'] }
    });
    try { await body(); } finally {
      const complete = once('Tracing.tracingComplete');
      await call('Tracing.end');
      await complete;
      off();
    }
    return events;
  }

  // v8.compile is nested inside EvaluateScript, so the two are reported side by side rather
  // than summed. Blink parses an inserted style element synchronously, so the cost of the
  // sheets the content script injects sits inside the untraced update() callback and is
  // picked up by the inject stage of the micro-benchmark below instead.
  function summarize(events) {
    const totals = {
      cosmeticScript: { count: 0, ms: 0 }, cosmeticCompile: { count: 0, ms: 0 }, script: { count: 0, ms: 0 },
      recalcStyle: { count: 0, ms: 0, elements: 0 }, layout: { count: 0, ms: 0 }
    };
    const isCosmetic = event => (event.args?.data?.url || '').includes('/content/ad-blocker');
    for (const event of events) {
      if (event.ph !== 'X') continue;
      const ms = (event.dur || 0) / 1000;
      if (event.name === 'v8.compile') {
        // Nested inside EvaluateScript, so reported separately rather than added to it.
        if (isCosmetic(event)) { totals.cosmeticCompile.count++; totals.cosmeticCompile.ms += ms; }
      } else if (event.name === 'EvaluateScript') {
        totals.script.count++;
        totals.script.ms += ms;
        if (isCosmetic(event)) { totals.cosmeticScript.count++; totals.cosmeticScript.ms += ms; }
      } else if (event.name === 'UpdateLayoutTree') {
        totals.recalcStyle.count++;
        totals.recalcStyle.ms += ms;
        totals.recalcStyle.elements += event.args?.elementCount ?? event.args?.beginData?.elementCount ?? 0;
      } else if (event.name === 'Layout') {
        totals.layout.count++;
        totals.layout.ms += ms;
      }
    }
    return totals;
  }

  // The sheet the content script adopts lives in the extension's isolated world, so it is
  // read there rather than from the page: the page sees its effect on computed style, which
  // the probes above cover, but not the sheet object itself.
  const collectSheet = `(() => {
    const sheets = document.adoptedStyleSheets || [];
    return {
      url: location.href,
      adopted: sheets.length,
      selectors: sheets.reduce((total, sheet) => total + (sheet.cssRules[0]?.selectorText.split(',').length ?? 0), 0)
    };
  })()`;

  // Evaluated once per document, in that document's own main-world execution context, so
  // the reading does not depend on how Chrome happened to distribute frames over processes.
  const collect = `(() => {
    const probes = ${JSON.stringify(PROBES)};
    const paint = {};
    for (const entry of performance.getEntriesByType('paint')) paint[entry.name] = entry.startTime;
    const sheets = [...document.querySelectorAll('style')];
    const hidden = {};
    for (const [name, selector] of Object.entries(probes)) {
      const element = document.querySelector(selector);
      hidden[name] = element ? getComputedStyle(element).display === 'none' : null;
    }
    return {
      url: location.href,
      firstPaint: paint['first-paint'] ?? null,
      firstContentfulPaint: paint['first-contentful-paint'] ?? null,
      styleElements: sheets.length,
      elements: document.querySelectorAll('*').length,
      hidden
    };
  })()`;

  async function measure() {
    const targetId = (await call('Target.createTarget', { url: 'about:blank' })).result.targetId;
    const session = (await call('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;
    // A cross-site frame runs out of process and is its own target; a cross-origin frame on
    // the same site stays in the page's process and only shows up as another execution
    // context. Both are collected, so the frame count does not depend on process allocation.
    const frameSessions = [];
    const contexts = [];
    // A content script runs in an isolated world, which is reported as a non-default
    // execution context named after the extension.
    const isolated = [];
    const off = on(message => {
      if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'iframe') frameSessions.push(message.params.sessionId);
      if (message.method !== 'Runtime.executionContextCreated' || message.sessionId !== session) return;
      const { context } = message.params;
      // A page's own context carries the page origin; a content script's isolated world
      // carries the extension origin and is named after the extension.
      if (context.auxData?.isDefault) { if (context.origin.startsWith('https://')) contexts.push(context.id); }
      else if (context.auxData?.type === 'isolated' && context.name === extensionName) isolated.push(context.id);
    });
    try {
      await call('Page.enable', {}, session);
      await call('Runtime.enable', {}, session);
      await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session);
      const events = await traced(async () => {
        const loaded = once('Page.loadEventFired', session);
        const navigated = await call('Page.navigate', { url: topUrl }, session);
        if (navigated.result.errorText) throw new Error(`${topUrl}: ${navigated.result.errorText}`);
        await loaded;
        await wait(SETTLE);
      });
      const documents = [];
      for (const contextId of contexts) documents.push(await evaluate(collect, session, contextId));
      for (const frameSession of frameSessions) documents.push(await evaluate(collect, frameSession));
      const sheets = [];
      for (const contextId of isolated) sheets.push(await evaluate(collectSheet, session, contextId));
      return { documents, sheets, trace: summarize(events) };
    } finally {
      off();
      await call('Target.closeTarget', { targetId });
    }
  }

  const metrics = sample => {
    const [top] = sample.documents;
    const paints = sample.documents.map(document => document.firstContentfulPaint).filter(value => value !== null);
    return {
      'documents': sample.documents.length,
      'cosmetic script ms (all frames)': sample.trace.cosmeticScript.ms,
      'of which V8 compile ms': sample.trace.cosmeticCompile.ms,
      'cosmetic script evaluations': sample.trace.cosmeticScript.count,
      'all script ms': sample.trace.script.ms,
      'style recalculation ms': sample.trace.recalcStyle.ms,
      'style recalculations': sample.trace.recalcStyle.count,
      'elements restyled': sample.trace.recalcStyle.elements,
      'layout ms': sample.trace.layout.ms,
      'top first paint ms': top.firstPaint,
      'top first contentful paint ms': top.firstContentfulPaint,
      'slowest first contentful paint ms': paints.length ? Math.max(...paints) : null,
      'style elements per document': Math.max(...sample.documents.map(document => document.styleElements)),
      'adopted sheets per document': Math.max(0, ...sample.sheets.map(sheet => sheet.adopted)),
      'frame sheet selectors': Math.max(0, ...sample.sheets.map(sheet => sheet.selectors))
    };
  };
  const median = values => {
    const usable = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
    if (!usable.length) return null;
    const middle = usable.length >> 1;
    return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
  };
  async function scenario(name) {
    const samples = [];
    for (let index = 0; index < runs; index++) samples.push(await measure());
    const rows = samples.map(metrics);
    return {
      name,
      documents: samples.at(-1).documents.map(({ url, hidden, styleElements, elements }) => ({ url, hidden, styleElements, elements })),
      sheets: samples.at(-1).sheets,
      median: Object.fromEntries(Object.keys(rows[0]).map(key => [key, median(rows.map(row => row[key]))])),
      runs: rows
    };
  }

  const results = [];
  results.push(await scenario('no extension'));

  const loaded = await call('Extensions.loadUnpacked', { path: root });
  if (loaded.error) throw new Error(JSON.stringify(loaded.error));
  const extensionTarget = (await call('Target.createTarget', { url: `chrome-extension://${loaded.result.id}/popup/popup.html` })).result.targetId;
  const extension = (await call('Target.attachToTarget', { targetId: extensionTarget, flatten: true })).result.sessionId;
  const message = request => evaluate(`chrome.runtime.sendMessage(${JSON.stringify(request)})`, extension);
  let state;
  for (let attempt = 0; attempt < 50; attempt++) {
    state = await message({ type: 'ad-blocker:get' }).catch(() => null);
    if (state?.ok) break;
    await wait(100);
  }
  assert.equal(state?.enabled, true, 'the ad blocker should be enabled by default');
  results.push(await scenario('cosmetic active'));

  assert.equal((await message({ type: 'ad-blocker:set-sites', sites: [TOP_HOST] })).ok, true);
  await wait(300);
  results.push(await scenario('cosmetic paused'));

  // The assembly stage, timed on its own. This is a replica of update() in
  // content/ad-blocker.js rather than the content script itself, so it is only trustworthy
  // as long as it produces the sheet the content script really adopted; that is asserted
  // below against the reading from the extension's isolated world. The host stays paused, so
  // the page is quiet while it runs, and the replica is handed the same inputs the frame
  // gets: the excepted list it loads and the selectors the service worker resolved for it.
  const stageTarget = (await call('Target.createTarget', { url: topUrl })).result.targetId;
  const stageSession = (await call('Target.attachToTarget', { targetId: stageTarget, flatten: true })).result.sessionId;
  await wait(SETTLE);
  const stageSamples = await evaluate(`(() => {
    const topSite = ${JSON.stringify(TOP_HOST)};
    const excepted = ${JSON.stringify(excepted)};
    const scoped = ${JSON.stringify(hostScoped)};
    const matches = (site, domain) => site === domain || site.endsWith('.' + domain);
    const applies = domains => {
      const placed = domains.filter(domain => !domain.startsWith('~'));
      return (!placed.length || placed.some(domain => matches(topSite, domain))) &&
        !domains.some(domain => domain.startsWith('~') && matches(topSite, domain.slice(1)));
    };
    const samples = [];
    for (let iteration = 0; iteration < ${runs}; iteration++) {
      const start = performance.now();
      const cancelled = new Set(excepted.filter(entry => applies(entry.d)).map(entry => entry.s));
      const selectors = [...new Set([...excepted.map(entry => entry.s), ...scoped])].filter(selector => !cancelled.has(selector));
      const assembled = performance.now();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(selectors.join(',') + '{display:none!important}');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      const adopted = performance.now();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(adoptedSheet => adoptedSheet !== sheet);
      samples.push({
        'selectors': selectors.length, 'style elements': 0,
        'assemble ms': assembled - start, 'adopt ms': adopted - assembled
      });
    }
    return samples;
  })()`, stageSession);
  await call('Target.closeTarget', { targetId: stageTarget });
  const stages = Object.fromEntries(Object.keys(stageSamples[0]).map(key => [key, median(stageSamples.map(sample => sample[key]))]));

  assert.equal((await message({ type: 'ad-blocker:set-sites', sites: [] })).ok, true);

  // A baseline that silently measured a no-op would make every later comparison worthless,
  // so the structural facts behind the numbers are asserted rather than assumed.
  const byName = Object.fromEntries(results.map(result => [result.name, result]));
  for (const result of results) assert.equal(result.median.documents, 1 + FRAME_HOSTS.length, `${result.name}: expected one top document and ${FRAME_HOSTS.length} frames`);
  const active = byName['cosmetic active'];
  for (const document of active.documents) {
    // Three from the registered stylesheet, one from the service worker's resolution, one
    // the frame assembled: every path a selector can reach a frame by is exercised.
    for (const probe of ['genericId', 'genericAttribute', 'genericCombinator', 'hostScoped', 'exceptedElsewhere']) {
      assert.equal(document.hidden[probe], true, `cosmetic active: ${PROBES[probe]} should be hidden in ${document.url}`);
    }
    assert.equal(document.hidden.exceptedOnHost, false, `cosmetic active: ${PROBES.exceptedOnHost} is excepted on ${TOP_HOST} and should stay visible in ${document.url}`);
    assert.equal(document.hidden.content, false, `cosmetic active: page content should stay visible in ${document.url}`);
    // The whole layer is now a registered stylesheet and one constructed sheet, so a style
    // element anywhere would mean the old injection path came back.
    assert.equal(document.styleElements, 0, `cosmetic active: ${document.url} should carry no style element`);
  }
  for (const document of byName['no extension'].documents) {
    for (const probe of ['genericId', 'genericAttribute', 'genericCombinator', 'exceptedElsewhere', 'hostScoped']) {
      assert.equal(document.hidden[probe], false, `no extension: ${PROBES[probe]} should stay visible in ${document.url}`);
    }
    assert.equal(document.styleElements, 0, `no extension: nothing should be injected into ${document.url}`);
  }
  const onPausedHost = url => {
    const { hostname } = new URL(url);
    return hostname === TOP_HOST || hostname.endsWith(`.${TOP_HOST}`);
  };
  for (const document of byName['cosmetic paused'].documents) {
    // Both per-host halves go quiet everywhere, because the service worker decides from the
    // top frame's host and hands a paused page nothing.
    for (const probe of ['exceptedElsewhere', 'hostScoped']) {
      assert.equal(document.hidden[probe], false, `cosmetic paused: ${PROBES[probe]} should stay visible in ${document.url}`);
    }
    // The registered stylesheet is excluded per document, so a cross-site frame inside the
    // paused page keeps it. That is the cost of applying it before the frame can ask who the
    // top frame is, and it is a narrowing of what pausing used to cover.
    assert.equal(document.hidden.genericId, !onPausedHost(document.url),
      `cosmetic paused: ${PROBES.genericId} should be ${onPausedHost(document.url) ? 'visible' : 'hidden'} in ${document.url}`);
    assert.equal(document.styleElements, 0, `cosmetic paused: nothing should be injected into ${document.url}`);
  }
  for (const name of ['no extension', 'cosmetic paused']) {
    assert.equal(byName[name].median['frame sheet selectors'], 0, `${name}: the frame should adopt no sheet`);
  }
  const adopted = active.median['frame sheet selectors'];
  assert.equal(active.median['adopted sheets per document'], 1, 'the frame should adopt exactly one sheet');
  assert.equal(stages.selectors, adopted, 'the timed replica of update() must produce the sheet the content script really adopted');
  assert.equal(adopted, artifacts.frameAssembled, 'the adopted sheet must match what the shipped artifacts resolve for this host');
  if (active.median['cosmetic script evaluations'] === 0) {
    console.warn('WARNING: the trace carried no EvaluateScript event for content/ad-blocker*, so the cosmetic script time reads as zero.');
  }

  const columns = results.map(result => result.name);
  const width = Math.max(...Object.keys(results[0].median).map(key => key.length));
  const format = value => value === null ? '-' : (Number.isInteger(value) ? String(value) : value.toFixed(1));
  console.log(`\nCosmetic filtering measurement, median of ${runs} run${runs === 1 ? '' : 's'} on ${topUrl} with ${FRAME_HOSTS.length} frames`);
  console.log(`${'metric'.padEnd(width)}  ${columns.map(name => name.padStart(16)).join('  ')}`);
  for (const key of Object.keys(results[0].median)) {
    console.log(`${key.padEnd(width)}  ${results.map(result => format(result.median[key]).padStart(16)).join('  ')}`);
  }
  console.log(`\nAssembly per frame on ${TOP_HOST}, median of ${runs} iteration${runs === 1 ? '' : 's'}:`
    + ` ${stages['assemble ms'].toFixed(1)} ms evaluating ${excepted.length} exception rules and unioning in`
    + ` ${hostScoped.length} resolved selector${hostScoped.length === 1 ? '' : 's'},`
    + ` ${stages['adopt ms'].toFixed(1)} ms building and adopting one sheet of ${stages.selectors} selectors.`
    + ` No CSS.supports() call and no style element.`);
  console.log(`V8's code cache makes the first navigation after an extension load the expensive one:`
    + ` ${active.runs[0]['cosmetic script ms (all frames)'].toFixed(1)} ms of cosmetic script across ${active.median.documents} documents on the first,`
    + ` ${active.runs.at(-1)['cosmetic script ms (all frames)'].toFixed(1)} ms on the last.`);
  console.log(`\nPer frame: ${artifacts.perFrameBytes.toLocaleString('en-US')} bytes parsed`
    + ` (${Object.entries(artifacts.perFrameFiles).map(([file, data]) => `${file} ${data.bytes.toLocaleString('en-US')}`).join(', ')}).`);
  console.log(`Ahead of the frame: ${artifacts.generic.selectors.toLocaleString('en-US')} generic selectors in`
    + ` ${artifacts.generic.file} as ${artifacts.generic.rules} registered rules over ${artifacts.generic.bytes.toLocaleString('en-US')} bytes, applied before first paint;`
    + ` ${artifacts.serviceWorker.bytes.toLocaleString('en-US')} bytes of host map in ${artifacts.serviceWorker.file}, parsed once per service worker wake.`);

  if (outPath) {
    await writeFile(resolve(root, outPath), `${JSON.stringify({
      generatedAt: new Date().toISOString(), chrome: version.Browser, runs, settleMs: SETTLE,
      fixture: { top: topUrl, frames: FRAME_HOSTS.map(host => `https://${host}/frame`) },
      probes: PROBES, artifacts, assembly: { median: stages, iterations: stageSamples }, scenarios: results
    }, null, 2)}\n`);
    console.log(`\nWrote ${outPath}`);
  }
  await call('Browser.close');
  closed = true;
} finally {
  socket?.close();
  if (!closed) browser.kill('SIGTERM');
  await Promise.race([browserExit, wait(5000)]);
  if (browser.exitCode === null) browser.kill('SIGKILL');
  await new Promise(done => server.close(done));
  for (const directory of [profile, certDir]) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
