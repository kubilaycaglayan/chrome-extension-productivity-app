const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const settings = readFileSync(path.join(root, "shared/cookie-accepter-settings.js"), "utf8");
const moduleDefaults = readFileSync(path.join(root, "shared/module-defaults.js"), "utf8");
const content = readFileSync(path.join(root, "content/cookie-accepter.js"), "utf8");
const adBlocker = readFileSync(path.join(root, "content/ad-blocker.js"), "utf8");
const excepted = readFileSync(path.join(root, "content/ad-blocker-excepted.js"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const popup = readFileSync(path.join(root, "popup/popup.js"), "utf8");
const popupHtml = readFileSync(path.join(root, "popup/popup.html"), "utf8");
// Browser fixtures are opt-in so the suite never launches or profiles system Chrome.
const chrome = process.env.CHROME_BINARY;
const run = promisify(execFile);
const context = { globalThis: {} };
vm.runInNewContext(settings, context);
const siteSettings = context.globalThis.cookieAccepterSettings;
vm.runInNewContext(moduleDefaults, context);
const defaults = context.globalThis.productivityModuleDefaults;
const registration = manifest.content_scripts.find(entry => entry.js.includes("content/cookie-accepter.js"));
assert.ok(registration?.all_frames && registration?.match_about_blank && registration?.run_at === "document_start");
assert.deepEqual(registration.js, ["shared/cookie-accepter-settings.js", "content/cookie-accepter.js"]);
// Accepting cookies on someone's behalf is a choice only they can make, so an unanswered
// setting has to read as "no". The popup's switch and the module itself both ask the shared
// defaults, and a backup from before this module existed restores that same "no".
assert.equal(defaults.optIn.includes("cookie-accepter"), true);
assert.equal(defaults.isEnabled("cookie-accepter", undefined), false);
assert.equal(defaults.isEnabled("cookie-accepter", true), true);
assert.match(popup, /input\.checked = productivityModuleDefaults\.isEnabled\(id, settings\[key\]\);/);
assert.match(popup, /for \(const id of productivityModuleDefaults\.optIn\) \{/);
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
  // The ad blocker's shipped excepted list is loaded as it ships, so this also asserts that
  // no consent selector reached it: the build drops them, and the content script no longer
  // filters per frame. `.ad-banner` stands in for what the service worker resolves.
  return `<!doctype html><html><head></head><body>
    <div id="cookieConsentUR99472">Consent container <button>Accept all</button></div>
    <div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler">Allow all</button></div>
    <div class="ad-banner">Advertisement</div>
    <div id="ad-carousel">Ad carousel</div>
    <script>
      let clicks = 0;
      const changed = [];
      window.chrome = {
        storage:{local:{get:async keys => Object.fromEntries(keys.map(key => [key, key === 'moduleEnabled:cookie-accepter' ? true : key === 'moduleEnabled:ad-blocker' ? ${adEnabled} : []]))},onChanged:{addListener:fn => changed.push(fn)}},
        runtime:{sendMessage:async () => ({ok:true,topSite:'localhost',enabled:${adEnabled},sites:[],cosmetic:${adEnabled ? "['.ad-banner']" : '[]'}})}
      };
      document.querySelector('#onetrust-accept-btn-handler').onclick = () => { clicks++; };
    </script><script>${excepted}</script><script>${adBlocker}</script><script>${settings}</script><script>${content}</script>
    <script>setTimeout(() => document.body.dataset.results = JSON.stringify({
      clicks,
      sheets: document.adoptedStyleSheets.length,
      hidden: Object.fromEntries(['.ad-banner', '#ad-carousel', '#cookieConsentUR99472', '#onetrust-banner-sdk']
        .map(selector => [selector, getComputedStyle(document.querySelector(selector)).display === 'none']))
    }), 800);</script>
  </body></html>`;
}

// A banner that is inserted hidden and later revealed by a stylesheet rule, not by a DOM or
// attribute change: nothing the MutationObserver can see makes it visible.
function fadeInPage() {
  return `<!doctype html><html><head><style>
      #onetrust-banner-sdk { opacity: 0; }
    </style></head><body>
    <script>
      const clicks = {};
      const store = { 'moduleEnabled:cookie-accepter': true, cookieAccepterPausedSites: [] };
      window.chrome = {storage:{local:{get:async keys => Object.fromEntries(keys.map(key => [key, store[key]]))},onChanged:{addListener:()=>{}}}};
    </script><script>${settings}</script><script>${content}</script>
    <script>
      setTimeout(() => {
        const banner = document.createElement('div'); banner.id = 'onetrust-banner-sdk';
        banner.innerHTML = '<button id="onetrust-accept-btn-handler">Allow all</button>';
        banner.querySelector('button').onclick = () => { clicks.faded = (clicks.faded || 0) + 1; };
        document.body.append(banner);
      }, 150);
      setTimeout(() => {
        clicks.beforeReveal = clicks.faded || 0;
        const sheet = document.querySelector('style').sheet;
        for (const rule of sheet.cssRules) if (rule.selectorText === '#onetrust-banner-sdk') rule.style.opacity = '1';
      }, 900);
      setTimeout(() => { document.body.dataset.results = JSON.stringify(clicks); }, 1900);
    </script></body></html>`;
}

// Three layouts the adapters used to walk past: Cookiebot's non-opt-in button, a Usercentrics
// wrapper that lays out no box of its own, and OneTrust raising its preference centre as the
// banner, with no simple accept bar to open it from.
function variantPage() {
  return `<!doctype html><html><head><style>
      #uc-banner-modal { display: contents; }
      #onetrust-pc-sdk { position: fixed; top: 0; left: 0; }
    </style></head><body>
    <div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonAccept">Allow all</button></div>
    <div id="uc-banner-modal"><div><button id="uc-btn-accept-banner">Accept all</button></div></div>
    <div id="onetrust-pc-sdk"><button id="accept-recommended-btn-handler">Allow All</button></div>
    <script>
      const clicks = {};
      const store = { 'moduleEnabled:cookie-accepter': true, cookieAccepterPausedSites: [] };
      window.chrome = {storage:{local:{get:async keys => Object.fromEntries(keys.map(key => [key, store[key]]))},onChanged:{addListener:()=>{}}}};
      document.querySelectorAll('button').forEach(button => button.onclick = () => {
        clicks[button.id] = (clicks[button.id] || 0) + 1;
        button.closest('#CybotCookiebotDialog, #uc-banner-modal, #onetrust-pc-sdk').remove();
      });
    </script><script>${settings}</script><script>${content}</script>
    <script>setTimeout(() => { document.body.dataset.results = JSON.stringify(clicks); }, 2100);</script>
  </body></html>`;
}

// A site that ships no CMP, modelled on mackolik.com: a pinned block of consent prose with its own
// accept-all button. The two decoys carry only one half of that shape each.
function customBannerPage() {
  return `<!doctype html><html><head><style>
      .cookie-consent-rectangle { position: fixed; bottom: 0; left: 0; right: 0; }
      .promo { position: fixed; top: 0; left: 0; }
    </style></head><body>
    <div class="cookie-consent-rectangle">
      <span>Mackolik İnternet Hizmetleri olarak kişisel verilerinize önem veriyoruz. İnternet sitemizin çalışması ve tercihleriniz doğrultusunda çerezler kullanmaktayız.</span>
      <div class="cookie-consent-buttons-wrapper">
        <button class="preferences-btn">Çerez Tercihleri</button>
        <button class="reject-all-btn">Tümünü Reddet</button>
        <button class="accept-all-btn">Tümünü Kabul Et</button>
      </div>
    </div>
    <div class="promo"><span>Subscribe to our weekly newsletter for match reports and offers.</span><button id="promo-accept">Accept all</button></div>
    <div id="inline-policy"><span>We use cookies and similar technologies to improve your experience on this website.</span><button id="inline-accept">Accept all</button></div>
    <script>
      const clicks = {};
      const store = { 'moduleEnabled:cookie-accepter': true, cookieAccepterPausedSites: [] };
      window.chrome = {storage:{local:{get:async keys => Object.fromEntries(keys.map(key => [key, store[key]]))},onChanged:{addListener:()=>{}}}};
      document.querySelectorAll('button').forEach(button => button.onclick = () => {
        const name = button.id || button.className;
        clicks[name] = (clicks[name] || 0) + 1;
      });
    </script><script>${settings}</script><script>${content}</script>
    <script>setTimeout(() => { document.body.dataset.results = JSON.stringify(clicks); }, 1700);</script>
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
  vm.runInNewContext(readFileSync(path.join(root, "shared/module-defaults.js"), "utf8"), settingsContext);
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
      res.setHeader("Content-Type", "text/html; charset=utf-8");
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
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const routes = {
      "/advanced": advancedPage, "/frame-host": frameHostPage, "/blank-frame-host": blankFrameHostPage,
      "/settings": settingsPage, "/fade-in": fadeInPage, "/variants": variantPage, "/custom": customBannerPage,
      "/ad-on": () => adCompatibilityPage(true), "/ad-off": () => adCompatibilityPage(false)
    };
    res.end(routes[url.pathname]
      ? routes[url.pathname]()
      : page(url.pathname === "/frame" ? "on" : url.pathname === "/spa" ? "spa" : url.searchParams.get("mode")));
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
    // The same preference-centre id, inline on a settings page rather than raised as an overlay,
    // must still be left alone.
    assert.match(settingsOutput, /data-results="0"/);
    const { stdout: spaOutput } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=1700", "--dump-dom", `http://localhost:${server.address().port}/spa`], { maxBuffer: 1024 * 1024 });
    const spaMatch = spaOutput.match(/data-results="([^"]+)"/);
    assert.ok(spaMatch, "Missing SPA results");
    const spaResults = JSON.parse(spaMatch[1].replaceAll("&quot;", '"'));
    assert.equal(spaResults["onetrust-accept-btn-handler"], 1);
    assert.equal(spaResults.delayed, 1);
    const dumpResults = async (route, budget, what) => {
      const { stdout: output } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", `--virtual-time-budget=${budget}`, "--dump-dom", `http://localhost:${server.address().port}/${route}`], { maxBuffer: 1024 * 1024 });
      const found = output.match(/data-results="([^"]+)"/);
      assert.ok(found, `Missing ${what} results`);
      return JSON.parse(found[1].replaceAll("&quot;", '"'));
    };
    const fadeResults = await dumpResults("fade-in", 2100, "fade-in");
    assert.equal(fadeResults.beforeReveal, 0, "A banner held at opacity 0 is left alone until it is shown");
    assert.equal(fadeResults.faded, 1, "A banner revealed by a stylesheet rule alone is still accepted");
    const variantResults = await dumpResults("variants", 2300, "CMP layout variant");
    assert.equal(variantResults.CybotCookiebotDialogBodyButtonAccept, 1, "Cookiebot's non-opt-in allow-all button is clicked");
    assert.equal(variantResults["uc-btn-accept-banner"], 1, "A Usercentrics wrapper with no layout box is still looked inside");
    assert.equal(variantResults["accept-recommended-btn-handler"], 1, "A OneTrust preference centre raised as the banner is accepted");
    const customResults = await dumpResults("custom", 1900, "bespoke banner");
    assert.equal(customResults["accept-all-btn"], 1, "A pinned bespoke consent banner is accepted");
    assert.equal(customResults["reject-all-btn"], undefined);
    assert.equal(customResults["preferences-btn"], undefined);
    assert.equal(customResults["promo-accept"], undefined, "A pinned overlay without consent text is left alone");
    assert.equal(customResults["inline-accept"], undefined, "Consent text that is not a pinned banner is left alone");
    for (const route of ["ad-on", "ad-off"]) {
      const { stdout: adOutput } = await run(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--virtual-time-budget=1200", "--dump-dom", `http://localhost:${server.address().port}/${route}`], { maxBuffer: 1024 * 1024 });
      const adMatch = adOutput.match(/data-results="([^"]+)"/);
      assert.ok(adMatch, `Missing ad compatibility results for ${route}`);
      const result = JSON.parse(adMatch[1].replaceAll("&quot;", '"'));
      assert.equal(result.clicks, 1, `Consent remains actionable with the ad blocker ${route === "ad-on" ? "on" : "off"}`);
      assert.equal(result.sheets, route === "ad-on" ? 1 : 0, "The cosmetic layer is one adopted stylesheet, or none at all");
      assert.equal(result.hidden[".ad-banner"], route === "ad-on", "Ad blocker keeps hiding what the service worker resolved");
      assert.equal(result.hidden["#ad-carousel"], route === "ad-on", "Ad blocker keeps hiding a generic selector this host does not cancel");
      assert.equal(result.hidden["#cookieConsentUR99472"], false, "Ad blocker leaves consent selectors visible");
      assert.equal(result.hidden["#onetrust-banner-sdk"], false, "Ad blocker leaves consent selectors visible");
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
    console.log("PASS cookie accepter browser fixtures: defaults, CMP adapters, timing, SPA navigation, site pause, preferences, shadow roots, frames, disable, ad blocker on/off, backup/restore, unrelated controls, fade-in reveal, Cookiebot/Usercentrics layout variants, bespoke banners and their decoys, preference centre as banner");
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
