// Scores the cookie accepter against the site corpus in tests/fixtures/cookie-cmp-sites.json.
// Every site is visited twice in throwaway browser contexts: once with the module disabled, to
// establish that a consent banner is really shown from here, and once with it enabled, to check
// that one click clears the banner, leaves a consent signal, and does not repeat on a reload.
// Sites that show no banner in the baseline pass are reported separately, never scored, because a
// missing banner means the region or the site, not the module.
//
// Run with an isolated browser binary; system Chrome is never used. Needs a Node with a global
// WebSocket (22+), same as tools/score-adblock-test.mjs:
//   CHROME_BINARY=/path/to/chrome-for-testing node tools/score-cookie-test.mjs [options]
// Options: --set=fixtures,adapters,other  --cmp=OneTrust,Didomi  --region=US|GB|DE|all
//          --limit=N  --offset=N  --concurrency=N  --json=path  --verbose
// Long runs are best taken in chunks with --offset/--limit: a headless browser that has been
// through a few hundred ad-heavy pages can die, and every later site would score as an error.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chromeBinary = process.env.CHROME_BINARY;
if (!chromeBinary || !existsSync(chromeBinary)) {
  throw new Error('Set CHROME_BINARY to an isolated Chrome for Testing binary; system Chrome is not used');
}

const flag = (name, fallback) => {
  const match = process.argv.find(argument => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const sets = flag('set', 'fixtures,adapters').split(',').filter(Boolean);
const cmpFilter = flag('cmp', '').split(',').filter(Boolean);
const region = flag('region', 'all');
const limit = Number(flag('limit', '0'));
const concurrency = Number(flag('concurrency', '5'));
const offset = Number(flag('offset', '0'));
const jsonOut = flag('json', '');
const verbose = process.argv.includes('--verbose');
const navigationTimeout = 25000;
const settleDelay = 7000;
const reloadSettleDelay = 6000;
const callTimeout = 20000;
const lateBannerDelay = 4000;
const maxSessions = 8;
const trace = process.argv.includes('--trace');

// The probe reads the module's own adapter table and accept phrases out of its source, so a new
// adapter is scored without touching this file.
const moduleSource = await readFile(resolve(root, 'content/cookie-accepter.js'), 'utf8');
const settingsSource = await readFile(resolve(root, 'shared/cookie-accepter-settings.js'), 'utf8');
const adapterBlock = moduleSource.match(/const adapters = \[([\s\S]*?)\n {2}\];/);
if (!adapterBlock) throw new Error('Adapter table not found; content/cookie-accepter.js changed shape.');
const adapterRows = [...adapterBlock[1].matchAll(/\{\s*name: "([^"]+)",\s*dialog: "([^"]+)",\s*action: "([^"]+)"(?:,\s*opener: "([^"]+)")?/g)]
  .map(([, name, dialog, action, opener]) => ({ name, dialog, action, opener: opener ?? null }));
if (!adapterRows.length) throw new Error('No adapters parsed; content/cookie-accepter.js changed shape.');
const actionSelectors = [...new Set(adapterRows.flatMap(row => [row.action, row.opener].filter(Boolean)))];
const openerSelectors = [...new Set(adapterRows.map(row => row.opener).filter(Boolean))];
const enabledKey = settingsSource.match(/key: "([^"]+)"/)?.[1];
const pausedKey = settingsSource.match(/pausedKey: "([^"]+)"/)?.[1];
if (!enabledKey || !pausedKey) throw new Error('Settings keys not found; shared/cookie-accepter-settings.js changed shape.');

const corpus = JSON.parse(await readFile(resolve(root, 'tests/fixtures/cookie-cmp-sites.json'), 'utf8'));
const inRegion = site => region === 'all' ||
  ((!site.onlyRegions?.length || site.onlyRegions.includes(region)) && !site.skipRegions?.includes(region));
const targets = [];
if (sets.includes('fixtures')) {
  for (const page of corpus.fixturePages) targets.push({ url: page.url, group: 'fixtures', cmp: page.label });
}
if (sets.includes('adapters')) {
  for (const [adapter, sites] of Object.entries(corpus.adapters)) {
    if (cmpFilter.length && !cmpFilter.includes(adapter)) continue;
    for (const site of sites.filter(inRegion)) targets.push({ url: site.url, group: adapter, cmp: site.cmp });
  }
}
if (sets.includes('other')) {
  for (const site of corpus.other.filter(inRegion)) targets.push({ url: site.url, group: 'other', cmp: site.cmp });
}
const selected = targets.slice(offset);
const queue = limit > 0 ? selected.slice(0, limit) : selected;
if (!queue.length) throw new Error('No sites selected; check --set, --cmp and --region');

// Banner detection is deliberately independent of the module's own selectors: an accept-style
// control inside a nearby block of consent text counts as a banner, whoever built it.
const probeSource = enabled => `(() => {
  const ENABLED = ${enabled};
  const ACTIONS = ${JSON.stringify(actionSelectors)};
  const OPENERS = ${JSON.stringify(openerSelectors)};
  const DIALOGS = ${JSON.stringify(adapterRows.map(row => ({ name: row.name, dialog: row.dialog })))};
  const ACCEPT = /^(accept|accept all|accept all cookies|accept cookies|accept & close|accept and close|allow|allow all|allow cookies|agree|i agree|i accept|agree and close|agree and proceed|ok|okay|got it|understood|continue|tümünü kabul et|hepsini kabul et|kabul et|alle akzeptieren|alles akzeptieren|akzeptieren|zustimmen|einverstanden|tout accepter|accepter|accepter et fermer|j'accepte|aceptar|aceptar todo|aceptar todas|accetta|accetta tutti|accetta tutto|alles accepteren|accepteren|aceitar|aceitar todos|aceitar tudo|godkänn alla|godkänn|zgadzam się|akceptuję|concordo|rozumiem)$/i;
  const CONSENT_TEXT = /cookie|consent|privacy|gdpr|ccpa|çerez|kvkk|datenschutz|rgpd|tracking|personal data|persoonsgegevens|dados pessoais/i;
  const CONSENT_KEY = /consent|optanon|didomi|euconsent|cmp|cookie|^uc_|_sp_|gdpr|privacy|onetrust|cybot/i;
  window.__cookieClicks = [];
  const originalClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function() {
    const hits = selectors => selectors.some(selector => { try { return this.matches(selector); } catch { return false; } });
    window.__cookieClicks.push({
      id: this.id || '',
      text: (this.textContent || this.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      matched: hits(ACTIONS),
      opener: hits(OPENERS)
    });
    return originalClick.call(this);
  };
  window.chrome = window.chrome || {};
  chrome.storage = {
    local: { get: async keys => Object.fromEntries(keys.map(key => [key, key === ${JSON.stringify(enabledKey)} ? ENABLED : []])) },
    onChanged: { addListener: () => {} }
  };

  const roots = () => {
    const found = [document];
    for (let i = 0; i < found.length && found.length < 60; i++) {
      for (const element of found[i].querySelectorAll('*')) if (element.shadowRoot) found.push(element.shadowRoot);
    }
    return found;
  };
  const visible = element => {
    if (!element || !element.isConnected || element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) !== 0;
  };
  const label = element => (element.innerText || element.textContent || element.getAttribute('aria-label') || element.value || '')
    .replace(/\\s+/g, ' ').trim();

  // Several CMPs leave an empty container behind after acceptance (Quantcast keeps
  // #qc-cmp2-container for the rest of the visit), so a dialog only counts while it still offers a
  // visible control to click.
  const actionable = dialog => [...dialog.querySelectorAll('button, [role="button"], input, a')].some(control => {
    if (!visible(control)) return false;
    // Leftover shells often still carry policy links, which are not a consent decision.
    return control.tagName !== 'A' || ACCEPT.test(label(control));
  });

  const findBanner = () => {
    for (const root of roots()) {
      for (const dialog of root.querySelectorAll(DIALOGS.map(entry => entry.dialog).join(', '))) {
        if (visible(dialog) && actionable(dialog)) {
          const name = DIALOGS.find(entry => { try { return dialog.matches(entry.dialog); } catch { return false; } })?.name;
          const accept = [...dialog.querySelectorAll('button, [role="button"], input, a')]
            .find(control => visible(control) && ACCEPT.test(label(control)));
          return {
            found: true, kind: 'adapter', cmp: name || 'adapter',
            control: accept ? label(accept) : '', acceptable: !!accept, sample: label(dialog).slice(0, 160)
          };
        }
      }
    }
    for (const root of roots()) {
      const controls = root.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"], [onclick]');
      for (let i = 0; i < controls.length && i < 3000; i++) {
        const control = controls[i];
        const text = label(control);
        if (text.length > 40 || !ACCEPT.test(text) || !visible(control)) continue;
        let node = control;
        for (let depth = 0; depth < 6 && node; depth++) {
          node = node.parentElement || node.getRootNode()?.host;
          if (!node || node.nodeType !== 1) break;
          const surrounding = label(node);
          if (surrounding.length >= 20 && surrounding.length <= 3000 && CONSENT_TEXT.test(surrounding)) {
            return { found: true, kind: 'generic', cmp: '', control: text, acceptable: true, sample: surrounding.slice(0, 160) };
          }
        }
      }
    }
    return { found: false, kind: '', cmp: '', control: '', acceptable: false, sample: '' };
  };

  window.__cookieProbe = () => {
    let storage = [];
    try { storage = Object.keys(localStorage); } catch {}
    const cookies = document.cookie.split(';').map(part => part.trim().split('=')[0]).filter(Boolean);
    return {
      url: location.href,
      clicks: window.__cookieClicks,
      banner: findBanner(),
      consent: [...new Set([...cookies, ...storage])].filter(key => CONSENT_KEY.test(key)).slice(0, 12)
    };
  };
})();
${settingsSource}
${moduleSource}`;

const sleep = ms => new Promise(done => setTimeout(done, ms));
const profile = await mkdtemp(join(tmpdir(), 'cookie-score-'));
const browser = spawn(chromeBinary, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1280,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });
let browserDown = false;
browser.once('exit', () => { browserDown = true; });

let socket;
try {
  let port;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await sleep(100); }
  }
  if (!port) throw new Error('Chrome DevTools did not start');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    for (const listener of listeners) listener(message);
  };
  // A wedged renderer (modal dialog, paused worker, crashed frame) would otherwise park a worker
  // forever, so every command carries its own deadline and reports back as an error instead.
  const call = (method, params = {}, sessionId) => new Promise(done => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      if (trace) process.stderr.write(`\n  timeout ${method}${sessionId ? ` (${sessionId.slice(0, 6)})` : ''}\n`);
      done({ error: { message: `${method} timed out` } });
    }, callTimeout);
    pending.set(id, message => { clearTimeout(timer); done(message); });
    if (trace) process.stderr.write(`\n  -> ${method}${sessionId ? ` (${sessionId.slice(0, 6)})` : ''}\n`);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  async function visit(url, enabled, withReload) {
    const context = (await call('Target.createBrowserContext', { disposeOnDetach: false })).result?.browserContextId;
    if (!context) throw new Error('could not create a browser context');
    const target = (await call('Target.createTarget', { url: 'about:blank', browserContextId: context })).result?.targetId;
    if (!target) throw new Error('could not create a page target');
    const session = (await call('Target.attachToTarget', { targetId: target, flatten: true })).result?.sessionId;
    if (!session) throw new Error('could not attach to the page target');
    const sessions = new Set([session]);
    const script = probeSource(enabled);
    let loaded;
    const listener = async message => {
      // Every visit sees every target event, so ownership is checked by browser context: sharing
      // frames between concurrent visits would merge their clicks, banners and cookies.
      if (message.method === 'Target.attachedToTarget' && message.params.targetInfo?.browserContextId === context) {
        const child = message.params.sessionId;
        // Out-of-process consent frames arrive as their own targets; instrument pages and frames
        // before they run, and resume everything else (workers) so page load is never held up.
        if (['page', 'iframe'].includes(message.params.targetInfo?.type) && sessions.size < maxSessions) {
          sessions.add(child);
          await call('Page.addScriptToEvaluateOnNewDocument', { source: script }, child);
        }
        if (message.params.waitingForDebugger) await call('Runtime.runIfWaitingForDebugger', {}, child);
      }
      if (message.method === 'Page.javascriptDialogOpening' && sessions.has(message.sessionId)) {
        await call('Page.handleJavaScriptDialog', { accept: false }, message.sessionId);
      }
      if (message.method === 'Page.loadEventFired' && message.sessionId === session) loaded?.();
    };
    listeners.add(listener);
    try {
      await call('Page.enable', {}, session);
      await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session);
      await call('Page.addScriptToEvaluateOnNewDocument', { source: script }, session);
      const waitForLoad = () => Promise.race([new Promise(done => { loaded = done; }), sleep(navigationTimeout)]);
      const load = waitForLoad();
      const navigation = await call('Page.navigate', { url }, session);
      if (navigation.error) throw new Error(navigation.error.message);
      if (navigation.result?.errorText) throw new Error(navigation.result.errorText);
      await load;
      await sleep(settleDelay);
      let after = await probe(call, sessions);
      // A banner that is still up may simply be mid-animation or have appeared late, so give the
      // module one more window before recording the page as unaccepted.
      if (after.banner.found && after.banner.acceptable) {
        await sleep(lateBannerDelay);
        after = await probe(call, sessions);
      }
      if (!withReload) return { after };
      const reload = waitForLoad();
      await call('Page.reload', { ignoreCache: false }, session);
      await reload;
      await sleep(reloadSettleDelay);
      return { after, returnVisit: await probe(call, sessions) };
    } finally {
      listeners.delete(listener);
      await call('Target.closeTarget', { targetId: target });
      await call('Target.disposeBrowserContext', { browserContextId: context });
    }
  }

  async function probe(call, sessions) {
    const merged = { clicks: [], banner: { found: false, kind: '', cmp: '', control: '', acceptable: false, sample: '' }, consent: [], url: '' };
    for (const session of sessions) {
      const response = await call('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__cookieProbe ? window.__cookieProbe() : null)', returnByValue: true
      }, session);
      const raw = response.result?.result?.value;
      if (!raw) continue;
      const value = JSON.parse(raw);
      if (!value) continue;
      merged.url ||= value.url;
      merged.clicks.push(...value.clicks);
      merged.consent.push(...value.consent);
      if (value.banner.found && !merged.banner.found) merged.banner = value.banner;
    }
    merged.consent = [...new Set(merged.consent)];
    return merged;
  }

  function score(baseline, treatment) {
    const accepted = treatment.after.clicks.filter(click => click.matched && !click.opener);
    const repeated = treatment.returnVisit.clicks.filter(click => click.matched && !click.opener);
    const fresh = treatment.after.consent.filter(key => !baseline.after.consent.includes(key));
    if (!baseline.after.banner.found) return { status: 'no-banner', detail: 'no consent banner shown from this region' };
    if (!baseline.after.banner.acceptable) {
      return { status: 'notice-only', detail: `${baseline.after.banner.cmp || 'banner'} offers no accept control (notice-only variant)` };
    }
    if (!accepted.length) {
      // Banner presence is per page load: if the enabled visit showed none either, there was
      // nothing to act on and the site says nothing about the module.
      if (!treatment.after.banner.found || !treatment.after.banner.acceptable) {
        return { status: 'inconclusive', detail: 'no acceptable banner in the enabled visit, only in the baseline one' };
      }
      const unrelated = treatment.after.clicks.length;
      const recognized = treatment.after.banner.kind === 'adapter';
      return {
        status: recognized ? 'missed-recognized' : 'missed-unrecognized',
        detail: recognized
          ? `${treatment.after.banner.cmp} dialog matched but no accept control was clicked${unrelated ? `, ${unrelated} unrelated click(s)` : ''}`
          : `banner not recognized by any adapter (control: ${treatment.after.banner.control || baseline.after.banner.control || 'unknown'})`
      };
    }
    if (treatment.after.banner.found && treatment.after.banner.acceptable) {
      return { status: 'banner-remains', detail: `clicked ${accepted[0].id || accepted[0].text}, banner still offers ${treatment.after.banner.control || 'an accept control'}` };
    }
    if (accepted.length > 1) return { status: 'multi-click', detail: `${accepted.length} accept clicks on one visit: ${[...new Set(accepted.map(click => click.id || click.text))].join(', ')}` };
    if (repeated.length) return { status: 'reclick', detail: `banner returned after reload, clicked ${repeated.length} more time(s)` };
    if (!fresh.length) return { status: 'no-consent-signal', detail: `clicked ${accepted[0].id || accepted[0].text}, banner gone, no new consent cookie or storage key` };
    return { status: 'pass', detail: `clicked ${accepted[0].id || accepted[0].text}; consent: ${fresh.slice(0, 3).join(', ')}` };
  }

  const results = [];
  const started = new Date().toISOString();
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (;;) {
      const site = queue.shift();
      if (!site) return;
      if (browserDown) {
        results.push({ ...site, status: 'error', detail: 'the browser exited; rerun this chunk with --offset' });
        continue;
      }
      let result;
      try {
        const baseline = await visit(site.url, false, false);
        const treatment = await visit(site.url, true, true);
        result = { ...site, ...score(baseline, treatment), baseline, treatment };
      } catch (error) {
        result = { ...site, status: 'error', detail: String(error.message || error).slice(0, 160) };
      }
      results.push(result);
      done++;
      process.stderr.write(`${done}/${done + queue.length} ${result.status.padEnd(18)} ${result.url}\n`);
      if (jsonOut) await writeFile(resolve(root, jsonOut), JSON.stringify({ run: started, sets, region, partial: queue.length > 0, results }, null, 2) + '\n');
    }
  });
  await Promise.all(workers);

  const order = ['pass', 'no-consent-signal', 'banner-remains', 'multi-click', 'reclick', 'missed-recognized', 'missed-unrecognized', 'notice-only', 'inconclusive', 'no-banner', 'error'];
  const byGroup = new Map();
  for (const result of results) {
    if (!byGroup.has(result.group)) byGroup.set(result.group, []);
    byGroup.get(result.group).push(result);
  }
  const scored = result => !['no-banner', 'notice-only', 'inconclusive', 'error'].includes(result.status);
  for (const [group, groupResults] of byGroup) {
    const relevant = groupResults.filter(scored);
    const passes = relevant.filter(result => result.status === 'pass').length;
    const percent = relevant.length ? Math.round((passes / relevant.length) * 100) : 0;
    console.log(`\n${group}: ${passes}/${relevant.length} pass (${percent}%)  [${groupResults.length - relevant.length} not scored]`);
    for (const result of groupResults.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))) {
      if (!verbose && result.status === 'pass') continue;
      console.log(`  ${result.status.padEnd(18)} ${result.url}  — ${result.detail}`);
    }
  }
  const relevant = results.filter(scored);
  const passes = relevant.filter(result => result.status === 'pass').length;
  const counts = order.map(status => [status, results.filter(result => result.status === status).length]).filter(([, count]) => count);
  console.log(`\nTotal: ${passes}/${relevant.length} pass (${relevant.length ? Math.round((passes / relevant.length) * 100) : 0}% of sites that showed a banner)`);
  console.log(counts.map(([status, count]) => `${status}: ${count}`).join('   '));
  if (jsonOut) {
    await writeFile(resolve(root, jsonOut), JSON.stringify({
      run: started, sets, region, chrome: version.Browser, results
    }, null, 2) + '\n');
    console.log(`\nDetails written to ${jsonOut}`);
  }
} finally {
  socket?.close();
  browser.kill();
  setTimeout(() => rm(profile, { recursive: true, force: true }), 500);
}
