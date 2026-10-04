// Manual live-site smoke check. Run with an isolated browser binary:
// CHROME_BINARY=/path/to/chrome-for-testing node tools/check-cookie-live.cjs URL
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) throw new Error("Pass an HTTP(S) URL");
const chromeBinary = process.env.CHROME_BINARY;
if (!chromeBinary || !fs.existsSync(chromeBinary)) throw new Error("Set CHROME_BINARY to an isolated Chrome for Testing binary; system Chrome is not used");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cookie-live-"));
const browser = spawn(chromeBinary, [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"
], { stdio: "ignore" });

async function waitForPort() {
  for (let i = 0; i < 100; i++) {
    try { return Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error("Chrome debugging port did not open");
}

async function connect(port) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = pages.find(page => page.type === "page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message));
    else task.resolve(message.result);
  };
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const next = ++id;
        pending.set(next, { resolve, reject });
        socket.send(JSON.stringify({ id: next, method, params }));
      });
    },
    close() { socket.close(); }
  };
}

(async () => {
  const port = await waitForPort();
  const client = await connect(port);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    const settings = fs.readFileSync(path.join(__dirname, "../shared/cookie-accepter-settings.js"), "utf8");
    const content = fs.readFileSync(path.join(__dirname, "../content/cookie-accepter.js"), "utf8");
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.__cookieAttempts = [];
      window.chrome = window.chrome || {};
      chrome.storage = {local:{get:async keys => Object.fromEntries(keys.map(key => [key, key === 'moduleEnabled:cookie-accepter' ? true : []]))}, onChanged:{addListener:()=>{}}};
      const originalClick = HTMLElement.prototype.click;
      HTMLElement.prototype.click = function() { window.__cookieAttempts.push({id:this.id, text:this.textContent.trim().slice(0,100)}); return originalClick.call(this); };
      ${settings}\n${content}
    ` });
    await client.send("Page.navigate", { url });
    await new Promise(resolve => setTimeout(resolve, 2500));
    if (new URL(url).hostname === "sandbox.didomi.io") {
      await client.send("Runtime.evaluate", { expression: `document.querySelector('button[onclick*="Didomi.reset"]')?.click()` });
    }
    if (new URL(url).hostname === "usercentrics.com") {
      await client.send("Runtime.evaluate", { expression: `window.__ucCmp?.showFirstLayer?.()` });
    }
    await new Promise(resolve => setTimeout(resolve, 6500));
    const expression = `JSON.stringify({url:location.href, attempts:window.__cookieAttempts || [], visibleBanners:['#onetrust-banner-sdk','#CybotCookiebotDialog','#didomi-host .didomi-notice-banner','#uc-center-container','#qc-cmp2-container'].filter(s=>{const x=document.querySelector(s);return x&&x.getClientRects().length>0&&getComputedStyle(x).visibility!=='hidden'}), controls:[...document.querySelectorAll('#qc-cmp2-container button, #didomi-host button, #CybotCookiebotDialog button')].map(x=>({id:x.id,text:x.innerText.trim(),mode:x.getAttribute('mode')})), cookies:document.cookie.split(';').map(x=>x.trim().split('=')[0]).filter(x=>/Optanon|CookieConsent|didomi|uc_|euconsent/i.test(x)), storage:Object.keys(localStorage).filter(x=>/consent|cookie|didomi|uc_/i.test(x))})`;
    const first = await client.send("Runtime.evaluate", { expression, returnByValue: true });
    await client.send("Page.reload", { ignoreCache: true });
    await new Promise(resolve => setTimeout(resolve, 7000));
    const second = await client.send("Runtime.evaluate", { expression, returnByValue: true });
    console.log(JSON.stringify({ site: url, date: new Date().toISOString(), fresh: JSON.parse(first.result.value), returnVisit: JSON.parse(second.result.value) }, null, 2));
  } finally { client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  browser.kill();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
});
