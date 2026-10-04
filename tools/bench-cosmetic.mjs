// Baseline benchmark for the cosmetic ad-blocking layer, phase 1 of
// plans/cosmetic-filtering-performance.md. Loads tests/fixtures/cosmetic-bench.html with
// two same-origin and three cross-origin frames in headless Chrome over CDP, and records
// the three numbers the plan is judged on: script evaluation time attributed to the
// cosmetic content scripts, time to first paint, and total style recalculation.
//
// Three scenarios run against the same fixture so the baseline is interpretable: no
// extension at all (the floor), the cosmetic layer active (the number to improve), and the
// benchmark host paused (the corpus is still parsed in every frame but nothing is computed
// or injected, which separates parse cost from filter-and-inject cost).
//
// One cost cannot be read out of the page: update() runs in the promise callback of the
// ad-blocker:get response, and Chrome attributes that work to neither a trace event nor
// Performance.ScriptDuration, so the scenarios above see only its effect on style
// recalculation. The benchmark therefore times the same three stages directly, running the
// current algorithm over the shipped corpus in a page's main world, and checks the selector
// count it produces against the count the browser actually injected.
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

const root = resolve(import.meta.dirname, '..');
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
// EasyList selectors and excepts four generic ones, so one fixture exercises the generic,
// domain-scoped and exception branches of the current runtime filter.
const TOP_HOST = 'screenrant.com';
const FRAME_HOSTS = [TOP_HOST, TOP_HOST, `static.${TOP_HOST}`, 'bench-frame-one.test', 'bench-frame-two.test'];
const PROBES = {
  genericId: '#AD_300',
  genericAttribute: '[data-ad-module]',
  genericCombinator: '.banner-img > .pbl',
  hostScoped: '.ad-zone-sidebar-default',
  exceptedOnHost: '.ad-current',
  content: '#article'
};
// Kept in step with content/ad-blocker.js, so the measured injection can be checked
// against the selector set the current runtime computes for TOP_HOST.
const CONSENT = /(?:cookie|consent|privacy|onetrust|didomi|usercentrics|quantcast|\bcmp\b)/i;
const matches = (site, domain) => site === domain || site.endsWith(`.${domain}`);
const applies = (domains, site) => {
  const positives = domains.filter(domain => !domain.startsWith('~'));
  return (!positives.length || positives.some(domain => matches(site, domain))) &&
    !domains.some(domain => domain.startsWith('~') && matches(site, domain.slice(1)));
};

const selectorSource = await readFile(resolve(root, 'content/ad-blocker-selectors.js'), 'utf8');
const entries = JSON.parse(selectorSource.match(/globalThis\.adBlockerSelectors = (\[[\s\S]*\]);/)[1]);
const hostExceptions = new Set(entries.filter(entry => entry.exception && applies(entry.domains, TOP_HOST)).map(entry => entry.selector));
const hostSelectors = [...new Set(entries
  .filter(entry => !entry.exception && applies(entry.domains, TOP_HOST) && !hostExceptions.has(entry.selector))
  .map(entry => entry.selector))].filter(selector => !CONSENT.test(selector));
const corpus = {
  file: 'content/ad-blocker-selectors.js',
  bytes: Buffer.byteLength(selectorSource),
  entries: entries.length,
  generic: entries.filter(entry => !entry.domains.length).length,
  domainScoped: entries.filter(entry => entry.domains.length).length,
  exceptions: entries.filter(entry => entry.exception).length,
  uniqueSelectors: new Set(entries.map(entry => entry.selector)).size,
  host: TOP_HOST,
  supportsCallsPerFrame: hostSelectors.length,
  styleElementsPerFrame: Math.ceil(hostSelectors.length / 250)
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
      injectedSelectors: sheets.reduce((total, sheet) => total + (sheet.textContent.match(/,/g)?.length ?? 0) + 1, 0),
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
    const off = on(message => {
      if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'iframe') frameSessions.push(message.params.sessionId);
      if (message.method === 'Runtime.executionContextCreated' && message.sessionId === session
        && message.params.context.auxData?.isDefault && message.params.context.origin.startsWith('https://')) contexts.push(message.params.context.id);
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
      return { documents, trace: summarize(events) };
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
      'injected selectors per document': Math.max(...sample.documents.map(document => document.styleElements ? document.injectedSelectors : 0))
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
      documents: samples.at(-1).documents.map(({ url, hidden, styleElements, injectedSelectors, elements }) => ({ url, hidden, styleElements, injectedSelectors, elements })),
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

  // The filter-and-inject stage, timed one stage at a time. This is a replica of update() in
  // content/ad-blocker.js rather than the content script itself, so it is only trustworthy
  // as long as it produces the selector set the browser was seen to inject; that is asserted
  // below. The host stays paused, so the page is quiet while it runs.
  const stageTarget = (await call('Target.createTarget', { url: topUrl })).result.targetId;
  const stageSession = (await call('Target.attachToTarget', { targetId: stageTarget, flatten: true })).result.sessionId;
  await wait(SETTLE);
  await evaluate(`${selectorSource}\nundefined;`, stageSession);
  const stageSamples = await evaluate(`(() => {
    const topSite = ${JSON.stringify(TOP_HOST)};
    const entries = globalThis.adBlockerSelectors;
    const matches = (site, domain) => site === domain || site.endsWith('.' + domain);
    const applies = domains => {
      const positives = domains.filter(domain => !domain.startsWith('~'));
      return (!positives.length || positives.some(domain => matches(topSite, domain))) &&
        !domains.some(domain => domain.startsWith('~') && matches(topSite, domain.slice(1)));
    };
    const samples = [];
    for (let iteration = 0; iteration < ${runs}; iteration++) {
      const start = performance.now();
      const exceptions = new Set(entries.filter(entry => entry.exception && applies(entry.domains)).map(entry => entry.selector));
      const kept = [...new Set(entries.filter(entry => !entry.exception && applies(entry.domains) && !exceptions.has(entry.selector)).map(entry => entry.selector))]
        .filter(selector => !${CONSENT}.test(selector));
      const filtered = performance.now();
      const supported = kept.filter(selector => CSS.supports('selector(' + selector + ')'));
      const checked = performance.now();
      const styles = [];
      for (let index = 0; index < supported.length; index += 250) {
        const style = document.createElement('style');
        style.textContent = supported.slice(index, index + 250).join(',') + ' { display: none !important; }';
        (document.head || document.documentElement).append(style);
        styles.push(style);
      }
      const injected = performance.now();
      for (const style of styles) style.remove();
      samples.push({
        'selectors': supported.length, 'style elements': styles.length,
        'filter ms': filtered - start, 'CSS.supports ms': checked - filtered, 'inject ms': injected - checked
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
  for (const document of byName['cosmetic active'].documents) {
    for (const probe of ['genericId', 'genericAttribute', 'genericCombinator', 'hostScoped']) {
      assert.equal(document.hidden[probe], true, `cosmetic active: ${PROBES[probe]} should be hidden in ${document.url}`);
    }
    assert.equal(document.hidden.exceptedOnHost, false, `cosmetic active: ${PROBES.exceptedOnHost} is excepted on ${TOP_HOST} and should stay visible in ${document.url}`);
    assert.equal(document.hidden.content, false, `cosmetic active: page content should stay visible in ${document.url}`);
  }
  for (const name of ['no extension', 'cosmetic paused']) {
    for (const document of byName[name].documents) {
      assert.equal(document.hidden.genericId, false, `${name}: ${PROBES.genericId} should stay visible in ${document.url}`);
      assert.equal(document.styleElements, 0, `${name}: nothing should be injected into ${document.url}`);
    }
  }
  const injected = byName['cosmetic active'].median['injected selectors per document'];
  assert.equal(stages.selectors, injected, 'the timed replica of update() must produce the selector set the browser was seen to inject');
  if (byName['cosmetic active'].median['cosmetic script evaluations'] === 0) {
    console.warn('WARNING: the trace carried no EvaluateScript event for content/ad-blocker*, so the cosmetic script time reads as zero.');
  }

  const columns = results.map(result => result.name);
  const width = Math.max(...Object.keys(results[0].median).map(key => key.length));
  const format = value => value === null ? '-' : (Number.isInteger(value) ? String(value) : value.toFixed(1));
  console.log(`\nCosmetic filtering baseline, median of ${runs} run${runs === 1 ? '' : 's'} on ${topUrl} with ${FRAME_HOSTS.length} frames`);
  console.log(`${'metric'.padEnd(width)}  ${columns.map(name => name.padStart(16)).join('  ')}`);
  for (const key of Object.keys(results[0].median)) {
    console.log(`${key.padEnd(width)}  ${results.map(result => format(result.median[key]).padStart(16)).join('  ')}`);
  }
  const active = byName['cosmetic active'];
  console.log(`\nFilter and inject per frame on ${TOP_HOST}, median of ${runs} iteration${runs === 1 ? '' : 's'}:`
    + ` ${stages['filter ms'].toFixed(1)} ms filtering the corpus,`
    + ` ${stages['CSS.supports ms'].toFixed(1)} ms in CSS.supports(),`
    + ` ${stages['inject ms'].toFixed(1)} ms inserting ${stages['style elements']} style elements.`);
  console.log(`V8's code cache makes the first navigation after an extension load the expensive one:`
    + ` ${active.runs[0]['cosmetic script ms (all frames)'].toFixed(1)} ms of cosmetic script across ${active.median.documents} documents on the first,`
    + ` ${active.runs.at(-1)['cosmetic script ms (all frames)'].toFixed(1)} ms on the last.`);
  console.log(`\nCorpus: ${corpus.bytes.toLocaleString('en-US')} bytes parsed per frame, ${corpus.entries.toLocaleString('en-US')} entries`
    + ` (${corpus.generic.toLocaleString('en-US')} generic, ${corpus.domainScoped.toLocaleString('en-US')} domain-scoped, ${corpus.exceptions} exceptions),`
    + ` ${corpus.uniqueSelectors.toLocaleString('en-US')} unique selectors.`);
  console.log(`On ${TOP_HOST} the current runtime filter keeps ${corpus.supportsCallsPerFrame.toLocaleString('en-US')} selectors,`
    + ` so it makes that many CSS.supports() calls and injects ${corpus.styleElementsPerFrame} style elements per frame;`
    + ` the browser injected ${injected === null ? 'none' : injected.toLocaleString('en-US')},`
    + ` meaning CSS.supports() rejected ${injected === null ? 'n/a' : corpus.supportsCallsPerFrame - injected}.`);

  if (outPath) {
    await writeFile(resolve(root, outPath), `${JSON.stringify({
      generatedAt: new Date().toISOString(), chrome: version.Browser, runs, settleMs: SETTLE,
      fixture: { top: topUrl, frames: FRAME_HOSTS.map(host => `https://${host}/frame`) },
      probes: PROBES, corpus, filterAndInject: { median: stages, iterations: stageSamples }, scenarios: results
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
