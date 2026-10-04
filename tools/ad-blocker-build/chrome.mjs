// A headless Chrome evaluation session over CDP, following the pattern
// tools/check-ad-blocker-live.mjs already uses. The cosmetic build needs it because
// Chrome's CSS parser is the only authority on whether a selector survives insertion,
// and one selector it rejects would drop the whole grouped rule it sits in.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function openChrome() {
  const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profile = await mkdtemp(join(tmpdir(), 'productivity-cosmetic-build-'));
  const browser = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' });
  const browserExit = new Promise(resolve => browser.once('exit', resolve));
  let socket;
  try {
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!port) throw new Error('Chrome DevTools did not start');
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Chrome DevTools socket failed')); });
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
    const target = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = (await call('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result;
    return {
      async evaluate(expression) {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.error) throw new Error(JSON.stringify(result.error));
        if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
        return result.result.result.value;
      },
      async close() {
        await call('Browser.close');
        socket.close();
        await Promise.race([browserExit, new Promise(resolve => setTimeout(resolve, 5000))]);
        if (browser.exitCode === null) browser.kill('SIGKILL');
        await rm(profile, { recursive: true, force: true });
      }
    };
  } catch (error) {
    socket?.close();
    browser.kill('SIGTERM');
    await Promise.race([browserExit, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
