const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const settings = readFileSync(path.join(root, "shared/cookie-accepter-settings.js"), "utf8");
const content = readFileSync(path.join(root, "content/cookie-accepter.js"), "utf8");
const adBlocker = readFileSync(path.join(root, "content/ad-blocker.js"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const popup = readFileSync(path.join(root, "popup/popup.js"), "utf8");
const popupHtml = readFileSync(path.join(root, "popup/popup.html"), "utf8");
// Browser fixtures are opt-in so the suite never launches or profiles system Chrome.
const chrome = process.env.CHROME_BINARY;
const run = promisify(execFile);
const context = { globalThis: {} };
vm.runInNewContext(settings, context);
const siteSettings = context.globalThis.cookieAccepterSettings;
const registration = manifest.content_scripts.find(entry => entry.js.includes("content/cookie-accepter.js"));
assert.ok(registration?.all_frames && registration?.match_about_blank && registration?.run_at === "document_start");
assert.deepEqual(registration.js, ["shared/cookie-accepter-settings.js", "content/cookie-accepter.js"]);
assert.match(popup, /id === "cookie-accepter" \? settings\[key\] === true/);
assert.match(popup, /cookieAccepterSettings\.key\] = false/);
assert.match(popup, /cookieAccepterPausedSites/);
assert.match(popup, /normalizeHost\(site\) === null/);
assert.equal(siteSettings.normalizeHost("EXAMPLE.COM."), "example.com");
for (const value of ["bad host", "https://example.com", "example..com", "-example.com", "example.com/path", ""]) {
  assert.equal(siteSettings.normalizeHost(value), null);
}

function advancedPage() {
  return `<!doctype html><html><body><div id="shadow-host"></div>
    <script>
      const clicks = {};
      const store = { 'moduleEnabled:cookie-accepter': true, cookieAccepterPausedSites: [] };
      const listeners = [];
      window.chrome = {storage:{local:{get:async keys => Object.fromEntries(keys.map(key => [key, store[key]]))},onChanged:{addListener:fn => listeners.push(fn)}}};
      const shadow = document.querySelector('#shadow-host').attachShadow({mode:'open'});
      shadow.innerHTML = '<div id="onetrust-banner-sdk"><button id="onetrust-pc-btn-handler">Preferences</button></div><div id="onetrust-pc-sdk" hidden><button id="accept-recommended-btn-handler">Accepter tout</button></div>';
      shadow.querySelector('#onetrust-pc-btn-handler').onclick = () => { clicks.preferencesOpened = (clicks.preferencesOpened || 0) + 1; shadow.querySelector('#onetrust-pc-sdk').hidden = false; shadow.querySelector('#onetrust-banner-sdk').remove(); };
      shadow.querySelector('#accept-recommended-btn-handler').onclick = () => { clicks.shadow = (clicks.shadow || 0) + 1; shadow.querySelector('#onetrust-pc-sdk').remove(); };
      const ucHost = document.createElement('div'); ucHost.id = 'usercentrics-root'; document.body.append(ucHost);
      const ucShadow = ucHost.attachShadow({mode:'open'});
      ucShadow.innerHTML = '<div id="uc-center-container"><button data-testid="uc-accept-all-button">Alle akzeptieren</button></div>';
      ucShadow.querySelector('button').onclick = () => { clicks.usercentrics = (clicks.usercentrics || 0) + 1; ucShadow.querySelector('#uc-center-container').remove(); };
    </script><script>${settings}</script><script>${content}</script>
    <script>
      setTimeout(() => {
        store['moduleEnabled:cookie-accepter'] = false;
        listeners.forEach(fn => fn({'moduleEnabled:cookie-accepter':{newValue:false}},'local'));
      }, 700);
      setTimeout(() => {
        const banner = document.createElement('div'); banner.id = 'onetrust-banner-sdk';
        banner.innerHTML = '<button id="onetrust-accept-btn-handler">Allow all</button>';
        banner.querySelector('button').onclick = () => { clicks.afterDisable = 1; };
        document.body.append(banner);
        history.pushState({}, '', '/new-route');
      }, 800);
      setTimeout(() => { document.body.dataset.results = JSON.stringify(clicks); }, 1300);
    </script></body></html>`;
}

function frameHostPage() {
  return `<!doctype html><html><body><iframe id="cmp-frame" src="/frame"></iframe><script>
    setTimeout(() => {
      const frame = document.querySelector('#cmp-frame');
      document.body.dataset.results = frame.contentDocument.body.dataset.results || '{}';
    }, 1550);
  </script></body></html>`;
}

function blankFrameHostPage() {
  const markup = JSON.stringify(page("on")).replaceAll("<", "\\u003c");
  return `<!doctype html><html><body><iframe id="cmp-frame" src="about:blank"></iframe><script>
    const frame = document.querySelector('#cmp-frame');
    setTimeout(() => {
      frame.contentDocument.open();
      frame.contentDocument.write(${markup});
      frame.contentDocument.close();
    }, 0);
    setTimeout(() => document.body.dataset.results = frame.contentDocument.body.dataset.results || '{}', 1900);
  </script></body></html>`;
}

function settingsPage() {
  return `<!doctype html><html><body>
    <div id="usercentrics-root"><button data-testid="uc-accept-all-button">Accept all</button></div>
    <div id="onetrust-pc-sdk"><button id="accept-recommended-btn-handler">Accept all</button></div>
    <div role="dialog"><button>Accept all</button></div>
    <script>
      let clicks = 0;
      document.querySelectorAll('button').forEach(button => button.onclick = () => clicks++);
      window.chrome = {storage:{local:{get:async () => ({'moduleEnabled:cookie-accepter':true,cookieAccepterPausedSites:[]})},onChanged:{addListener:()=>{}}}};
    </script><script>${settings}</script><script>${content}</script>
    <script>setTimeout(() => document.body.dataset.results = String(clicks), 700);</script>
  </body></html>`;
}

function adCompatibilityPage(adEnabled) {
  return `<!doctype html><html><head></head><body>
    <div id="cookieConsentUR99472">Consent container <button>Accept all</button></div>
    <div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler">Allow all</button></div>
    <div class="ad-banner">Advertisement</div>
    <script>
      let clicks = 0;
      const changed = [];
      window.chrome = {
        storage:{local:{get:async keys => Object.fromEntries(keys.map(key => [key, key === 'moduleEnabled:cookie-accepter' ? true : key === 'moduleEnabled:ad-blocker' ? ${adEnabled} : []]))},onChanged:{addListener:fn => changed.push(fn)}},
        runtime:{sendMessage:async () => ({ok:true,topSite:'localhost',enabled:${adEnabled},sites:[]})}
      };
      document.querySelector('#onetrust-accept-btn-handler').onclick = () => { clicks++; };
      globalThis.adBlockerSelectors = [
        {selector:'#cookieConsentUR99472',domains:[],exception:false},
        {selector:'#onetrust-banner-sdk',domains:[],exception:false},
        {selector:'.ad-banner',domains:[],exception:false}
      ];
    </script><script>${adBlocker}</script><script>${settings}</script><script>${content}</script>
    <script>setTimeout(() => document.body.dataset.results = JSON.stringify({clicks,styles:[...document.querySelectorAll('style')].map(style=>style.textContent)}),800);</script>
  </body></html>`;
}

function popupMock() {
  return `<script>
    const values = {'moduleEnabled:page-outline':false,cookieAccepterPausedSites:[]};
    const changeListeners = [];
    window.__store = values;
    window.chrome = {
      tabs:{query:async()=>[{id:1,url:'https://shop.example/'}]},
      storage:{local:{
        get:async keys=>typeof keys==='string'?{[keys]:values[keys]}:Object.fromEntries(keys.map(key=>[key,values[key]])),
        set:async next=>{const changes={};for(const [key,newValue] of Object.entries(next)){const oldValue=values[key];values[key]=newValue;changes[key]={oldValue,newValue};}changeListeners.forEach(fn=>fn(changes,'local'));},
        remove:async key=>{delete values[key];}
      },onChanged:{addListener:fn=>changeListeners.push(fn)}},
      scripting:{executeScript:async()=>[{result:[]}]}
    };
    URL.createObjectURL=blob=>{window.__backupBlob=blob;return 'blob:test-backup';};
    HTMLAnchorElement.prototype.click=function(){if(this.download)window.__downloadName=this.download;};
  </script>`;
}

function popupPage() {
  const exercise = `<script>
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    (async()=>{
      try {
        await delay(250);
        document.getElementById('open-settings').click();
        const module=[...document.querySelectorAll('#group-browser input')].find(input=>input.getAttribute('aria-label')==='Cookie accepter');
        const defaultOff=module && !module.checked;
        module.checked=true;module.dispatchEvent(new Event('change',{bubbles:true}));
        const pause=document.getElementById('cookie-pause-toggle');
        pause.checked=true;pause.dispatchEvent(new Event('change',{bubbles:true}));
        await delay(80);
        document.getElementById('export-settings').click();
        await delay(80);
        const exported=JSON.parse(await window.__backupBlob.text());
        const input=document.getElementById('import-settings');
        async function importBackup(backup){Object.defineProperty(input,'files',{configurable:true,value:[{text:async()=>JSON.stringify(backup)}]});input.dispatchEvent(new Event('change',{bubbles:true}));await delay(80);}
        await importBackup({version:1,modules:{}});
        const legacyOff=window.__store['moduleEnabled:cookie-accepter']===false&&window.__store.cookieAccepterPausedSites.length===0;
        await importBackup({version:1,modules:{'cookie-accepter':true},cookieAccepterPausedSites:['SHOP.EXAMPLE']});
        const restored=window.__store['moduleEnabled:cookie-accepter']===true&&window.__store.cookieAccepterPausedSites[0]==='shop.example';
        await importBackup({version:1,modules:{'cookie-accepter':true},cookieAccepterPausedSites:['https://evil.example']});
        const invalidRejected=window.__store.cookieAccepterPausedSites[0]==='shop.example';
        document.body.dataset.popupResults=JSON.stringify({defaultOff,exportEnabled:exported.modules['cookie-accepter'],exportPaused:exported.cookieAccepterPausedSites,legacyOff,restored,invalidRejected});
      } catch(error){document.body.dataset.popupError=String(error&&error.stack||error);}
    })();
  </script>`;
  return popupHtml
    .replace("<script src=\"../shared/mackolik-settings.js\"", `${popupMock()}<script src="../shared/mackolik-settings.js"`)
    .replace("</body>", `${exercise}</body>`);
}

function page(mode) {
  return `<!doctype html><html><body>
    <button id="unrelated">Accept all</button><div id="newsletter"><button id="newsletter-button">Accept all</button></div>
    <div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler">Allow all</button></div>
    <div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll">Alle akzeptieren</button></div>
    <div id="didomi-host"><div class="didomi-notice-banner"><button id="didomi-notice-agree-button">Accepter et fermer</button></div></div>
    <div id="usercentrics-root"><div id="uc-center-container"><button data-testid="uc-accept-all-button">Tout accepter</button></div></div>
    <div id="qc-cmp2-container"><div class="qc-cmp2-summary-buttons"><button mode="primary">CONCORDO</button><button>Save</button></div></div>
    <script>
      const clicks = {};
      const store = { 'moduleEnabled:cookie-accepter': ${mode !== "off"}, cookieAccepterPausedSites: ${mode === "pause" ? '["localhost"]' : '[]'} };
      const listeners = [];
      window.chrome = {storage:{local:{get:async keys => Object.fromEntries(keys.map(key => [key, store[key]]))},onChanged:{addListener:fn => listeners.push(fn)}}};
      document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
        clicks[button.id || button.textContent] = (clicks[button.id || button.textContent] || 0) + 1;
        if (button.closest('#onetrust-banner-sdk,#CybotCookiebotDialog,#didomi-host,#usercentrics-root,#qc-cmp2-container')) button.closest('#onetrust-banner-sdk,#CybotCookiebotDialog,#didomi-host,#usercentrics-root,#qc-cmp2-container').remove();
      }));
    </script>
    <script>${settings}</script><script>${content}</script>
    <script>
      setTimeout(() => {
        if (${mode === "spa"}) history.pushState({}, '', '/client-route');
        const banner = document.createElement('div'); banner.id = 'onetrust-banner-sdk';
        banner.innerHTML = '<button id="onetrust-accept-btn-handler">Allow all</button>';
        banner.querySelector('button').onclick = () => { clicks.delayed = (clicks.delayed || 0) + 1; banner.remove(); };
        document.body.append(banner);
      }, 200);
      setTimeout(() => {
        document.body.dataset.results = JSON.stringify(clicks);
      }, 1300);
    </script>
  </body></html>`;
}

(async () => {
  const starts = [];
  const settingsContext = {
    chrome: { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}) } } }
  };
  settingsContext.globalThis = settingsContext;
  vm.runInNewContext(readFileSync(path.join(root, "content/module-settings.js"), "utf8"), settingsContext);
  settingsContext.productivityModules.register("cookie-accepter", () => { starts.push("cookie"); return () => {}; });
  settingsContext.productivityModules.register("tab-marker", () => { starts.push("tab-marker"); return () => {}; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, ["tab-marker"], "Cookie accepter defaults off while existing modules keep their default");

  if (!chrome) {
    console.log("PASS cookie accepter static and settings checks; browser fixtures skipped (set CHROME_BINARY to an isolated test browser)");
    return;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/popup" || url.pathname === "/popup/") {
      res.setHeader("Content-Type", "text/html");
      res.end(popupPage());
      return;
    }
    if (["/popup/", "/shared/", "/assets/"].some(prefix => url.pathname.startsWith(prefix))) {
      const file = path.resolve(root, `.${url.pathname}`);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      const ext = path.extname(file);
      res.setHeader("Content-Type", ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".png" ? "image/png" : "application/octet-stream");
      try { res.end(readFileSync(file)); } catch { res.writeHead(404).end(); }
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(url.pathname === "/advanced" ? advancedPage() : url.pathname === "/frame-host" ? frameHostPage() : url.pathname === "/blank-frame-host" ? blankFrameHostPage() : url.pathname === "/settings" ? settingsPage() : url.pathname === "/ad-on" ? adCompatibilityPage(true) : url.pathname === "/ad-off" ? adCompatibilityPage(false) : page(url.pathname === "/frame" ? "on" : url.pathname === "/spa" ? "spa" : url.searchParams.get("mode")));
  });
  await new Promise(resolve => server.listen(0, "localhost", resolve));
  try {
    for (const mode of ["on", "off", "pause"]) {
      const url = `http://localhost:${server.address().port}/?mode=${mode}`;
      const { stdout } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=1700", "--dump-dom", url], { maxBuffer: 1024 * 1024 });
      const match = stdout.match(/data-results="([^"]+)"/);
      assert.ok(match, `Missing browser results for ${mode}`);
      const results = JSON.parse(match[1].replaceAll("&quot;", '"'));
      if (mode === "on") {
        for (const key of ["onetrust-accept-btn-handler", "CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "didomi-notice-agree-button", "Tout accepter", "CONCORDO", "delayed"]) {
          assert.equal(results[key], 1, `${key} should be clicked once`);
        }
        assert.equal(results.unrelated, undefined);
        assert.equal(results["newsletter-button"], undefined);
        assert.equal(results.Save, undefined);
      } else assert.deepEqual(results, {}, `${mode} should make no consent action`);
    }
    const { stdout } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=1700", "--dump-dom", `http://localhost:${server.address().port}/advanced`], { maxBuffer: 1024 * 1024 });
    const match = stdout.match(/data-results="([^"]+)"/);
    assert.ok(match, "Missing advanced browser results");
    const results = JSON.parse(match[1].replaceAll("&quot;", '"'));
    assert.equal(results.shadow, 1);
    assert.equal(results.preferencesOpened, 1);
    assert.equal(results.usercentrics, 1);
    assert.equal(results.afterDisable, undefined);
    const { stdout: frameOutput } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=1900", "--dump-dom", `http://localhost:${server.address().port}/frame-host`], { maxBuffer: 1024 * 1024 });
    const frameMatch = frameOutput.match(/data-results="([^"]+)"/);
    assert.ok(frameMatch, "Missing frame results");
    const frameResults = JSON.parse(frameMatch[1].replaceAll("&quot;", '"'));
    assert.equal(frameResults["onetrust-accept-btn-handler"], 1);
    const { stdout: blankFrameOutput } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=2300", "--dump-dom", `http://localhost:${server.address().port}/blank-frame-host`], { maxBuffer: 1024 * 1024 });
    const blankFrameMatch = blankFrameOutput.match(/data-results="([^"]+)"/);
    assert.ok(blankFrameMatch, `Missing inherited-origin frame results: ${blankFrameOutput.slice(-500)}`);
    const blankFrameResults = JSON.parse(blankFrameMatch[1].replaceAll("&quot;", '"'));
    assert.equal(blankFrameResults["onetrust-accept-btn-handler"], 1);
    const { stdout: settingsOutput } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=1000", "--dump-dom", `http://localhost:${server.address().port}/settings`], { maxBuffer: 1024 * 1024 });
    assert.match(settingsOutput, /data-results="0"/);
    const { stdout: spaOutput } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=1700", "--dump-dom", `http://localhost:${server.address().port}/spa`], { maxBuffer: 1024 * 1024 });
    const spaMatch = spaOutput.match(/data-results="([^"]+)"/);
    assert.ok(spaMatch, "Missing SPA results");
    const spaResults = JSON.parse(spaMatch[1].replaceAll("&quot;", '"'));
    assert.equal(spaResults["onetrust-accept-btn-handler"], 1);
    assert.equal(spaResults.delayed, 1);
    for (const route of ["ad-on", "ad-off"]) {
      const { stdout: adOutput } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=1200", "--dump-dom", `http://localhost:${server.address().port}/${route}`], { maxBuffer: 1024 * 1024 });
      const adMatch = adOutput.match(/data-results="([^"]+)"/);
      assert.ok(adMatch, `Missing ad compatibility results for ${route}`);
      const result = JSON.parse(adMatch[1].replaceAll("&quot;", '"'));
      assert.equal(result.clicks, 1, `Consent remains actionable with the ad blocker ${route === "ad-on" ? "on" : "off"}`);
      if (route === "ad-on") {
        assert.ok(result.styles.some(style => style.includes(".ad-banner")), "Ad blocker keeps its regular cosmetic rules");
        assert.ok(result.styles.every(style => !/cookieConsentUR99472|onetrust-banner-sdk/i.test(style)), "Ad blocker leaves consent selectors visible");
      }
    }
    const { stdout: popupOutput } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=1600", "--dump-dom", `http://localhost:${server.address().port}/popup/`], { maxBuffer: 1024 * 1024 });
    assert.doesNotMatch(popupOutput, /data-popup-error=/);
    const popupMatch = popupOutput.match(/data-popup-results="([^"]+)"/);
    assert.ok(popupMatch, "Missing popup integration results");
    const popupResults = JSON.parse(popupMatch[1].replaceAll("&quot;", '"'));
    assert.equal(popupResults.defaultOff, true);
    assert.equal(popupResults.exportEnabled, true);
    assert.deepEqual(JSON.parse(JSON.stringify(popupResults.exportPaused)), ["shop.example"]);
    assert.equal(popupResults.legacyOff, true);
    assert.equal(popupResults.restored, true);
    assert.equal(popupResults.invalidRejected, true);
    console.log("PASS cookie accepter browser fixtures: defaults, CMP adapters, timing, SPA navigation, site pause, preferences, shadow roots, frames, disable, ad blocker on/off, backup/restore, unrelated controls");
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
