// Scores the extension's ruleset against the adblock.turtlecute.org host list.
// Chrome evaluates the real loaded rulesets via declarativeNetRequest.testMatchOutcome,
// so no ad-network traffic is involved and the result is deterministic.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/adblock-probes.json'), 'utf8'));
const withExtra = process.argv.includes('--extra');
const verbose = process.argv.includes('--verbose');
const initiator = 'https://adblock.turtlecute.org';
const types = ['script', 'xmlhttprequest', 'image', 'sub_frame'];

const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'productivity-adblock-score-'));
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
  const target = await call('Target.createTarget', { url: `chrome-extension://${extensionId}/popup/popup.html` });
  const session = (await call('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
    return result.result.result.value;
  };
  await new Promise(resolve => setTimeout(resolve, 800));

  if (withExtra) await evaluate("chrome.declarativeNetRequest.updateEnabledRulesets({enableRulesetIds:['easylist_ads_extra','easylist_ads_extra_2']})");
  await new Promise(resolve => setTimeout(resolve, 400));
  const rulesets = await evaluate('chrome.declarativeNetRequest.getEnabledRulesets()');

  // One evaluate per host keeps the CDP round trips down; Chrome resolves all four types in page.
  const classify = async host => {
    const verdicts = await evaluate(`(async () => {
      const out = {};
      for (const type of ${JSON.stringify(types)}) {
        const r = await chrome.declarativeNetRequest.testMatchOutcome(
          { url: 'https://${host}/ads.js', initiator: ${JSON.stringify(initiator)}, type });
        out[type] = r.matchedRules.map(m => m.rulesetId);
      }
      return out;
    })()`);
    const hit = Object.entries(verdicts).find(([, ids]) => ids.length > 0);
    return { host, blocked: Boolean(hit), by: hit ? `${hit[0]}:${hit[1].join(',')}` : null };
  };

  let total = 0;
  let blocked = 0;
  const misses = [];
  const lines = [];
  for (const [group, categories] of Object.entries(fixture.groups)) {
    let groupTotal = 0;
    let groupBlocked = 0;
    const detail = [];
    for (const [category, hosts] of Object.entries(categories)) {
      let categoryBlocked = 0;
      for (const host of hosts) {
        const result = await classify(host);
        groupTotal++;
        if (result.blocked) { groupBlocked++; categoryBlocked++; }
        else misses.push(`${group}/${category}  ${host}`);
        if (verbose) lines.push(`  ${result.blocked ? 'BLOCK' : '  -  '}  ${host}${result.by ? `   (${result.by})` : ''}`);
      }
      detail.push(`    ${String(categoryBlocked).padStart(2)}/${String(hosts.length).padEnd(2)}  ${category}`);
    }
    total += groupTotal;
    blocked += groupBlocked;
    const pct = Math.round((groupBlocked / groupTotal) * 100);
    lines.push(`${group}: ${groupBlocked}/${groupTotal} (${pct}%)`);
    lines.push(...detail);
  }

  console.log(`Rulesets enabled: ${rulesets.join(', ') || '(none)'}`);
  console.log(`Probe list: ${fixture.source} (retrieved ${fixture.retrieved})\n`);
  console.log(lines.join('\n'));
  console.log(`\nTOTAL ${blocked}/${total} (${Math.round((blocked / total) * 100)}%)`);
  if (misses.length) {
    console.log(`\nNot covered (${misses.length}):`);
    console.log(misses.map(m => `  ${m}`).join('\n'));
  }
  await call('Browser.close');
  closed = true;
} finally {
  socket?.close();
  if (!closed) browser.kill('SIGTERM');
  await Promise.race([browserExit, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (browser.exitCode === null) browser.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
