const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../content/dark-mode.js'), 'utf8');

test('global script and popup switch are wired into the extension', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
  const script = manifest.content_scripts.find(entry => entry.js.includes('content/dark-mode.js'));
  assert.ok(script);
  assert.deepEqual(script.matches, ['<all_urls>']);
  assert.equal(script.run_at, 'document_start');
  const popup = fs.readFileSync(path.join(__dirname, '../popup/popup.html'), 'utf8');
  const mainView = popup.slice(0, popup.indexOf('id="settings-view"'));
  assert.match(mainView, /id="dark-mode-toggle"/);
  assert.match(mainView, /id="dark-mode-site-toggle"/);
  assert.doesNotMatch(mainView, /dark-mode-description/);
  const popupScript = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');
  assert.match(popupScript, /darkMode: settings\[darkModeKey\] === true/);
  assert.match(popupScript, /settings\[darkModeKey\] = backup\.darkMode/);
  assert.match(popupScript, /darkModeSites/);
});

function page(initialValue, bodyColor = 'rgb(255, 255, 255)', hostname = 'example.com', initialSites = []) {
  let stored = initialValue;
  let sites = initialSites;
  let listener;
  let pendingGet;
  let rootColor = 'rgba(0, 0, 0, 0)';
  const root = {
    lastElementChild: null,
    appendChild(node) { this.lastElementChild = node; node.parentNode = this; }
  };
  const style = {
    parentNode: null,
    remove() {
      if (this.parentNode) this.parentNode.lastElementChild = null;
      this.parentNode = null;
    }
  };
  const body = {};
  const context = {
    document: {
      documentElement: root,
      body,
      createElement: () => style,
      addEventListener: () => {}
    },
    location: { hostname },
    getComputedStyle: element => ({ backgroundColor: element === body ? bodyColor : rootColor }),
    requestAnimationFrame: callback => callback(),
    MutationObserver: class { observe() {} },
    chrome: {
      storage: {
        local: { get: () => new Promise(resolve => { pendingGet = resolve; }) },
        onChanged: { addListener: callback => { listener = callback; } }
      }
    }
  };
  vm.runInNewContext(source, context);
  return {
    root,
    style,
    load: async () => { pendingGet({ 'moduleEnabled:dark-mode': stored, darkModeSites: sites }); await Promise.resolve(); },
    toggle: value => { stored = value; listener({ 'moduleEnabled:dark-mode': { newValue: value } }, 'local'); },
    setSites: value => { sites = value; listener({ darkModeSites: { newValue: value } }, 'local'); },
    setBodyColor: value => { bodyColor = value; },
    setRootColor: value => { rootColor = value; }
  };
}

test('dark mode is off by default and changes open pages immediately', async () => {
  const tab = page(undefined);
  await tab.load();
  assert.equal(tab.style.parentNode, null);
  tab.toggle(true);
  assert.equal(tab.style.parentNode, tab.root);
  assert.match(tab.style.textContent, /filter: invert\(1\) hue-rotate\(180deg\)/);
  assert.match(tab.style.textContent, /img, video, canvas/);
  tab.toggle(false);
  assert.equal(tab.style.parentNode, null);
});

test('site switch applies only on matching hostnames and persists across page loads', async () => {
  const matching = page(false, 'rgb(255, 255, 255)', 'example.com', ['example.com']);
  const other = page(false, 'rgb(255, 255, 255)', 'other.example', ['example.com']);
  await matching.load();
  await other.load();
  assert.equal(matching.style.parentNode, matching.root);
  assert.equal(other.style.parentNode, null);
  matching.setSites([]);
  assert.equal(matching.style.parentNode, null);
  other.setSites(['other.example']);
  assert.equal(other.style.parentNode, other.root);
});

test('global and site switches enable dark mode independently', async () => {
  const tab = page(true, 'rgb(255, 255, 255)', 'example.com', ['example.com']);
  await tab.load();
  tab.toggle(false);
  assert.equal(tab.style.parentNode, tab.root);
  tab.toggle(true);
  tab.setSites([]);
  assert.equal(tab.style.parentNode, tab.root);
  tab.toggle(false);
  assert.equal(tab.style.parentNode, null);
});

test('already dark pages keep their existing colors', async () => {
  const tab = page(true, 'rgb(20, 25, 35)');
  await tab.load();
  assert.equal(tab.style.parentNode, null);
  tab.setBodyColor('rgb(255, 255, 255)');
  tab.toggle(false);
  tab.toggle(true);
  assert.equal(tab.style.parentNode, tab.root);
});

test('root background is checked when the body is transparent', async () => {
  const tab = page(true, 'rgba(0, 0, 0, 0)');
  tab.setRootColor('rgb(12, 16, 22)');
  await tab.load();
  assert.equal(tab.style.parentNode, null);
});

test('enabling dark mode injects the script into already open website tabs', async () => {
  const background = fs.readFileSync(path.join(__dirname, '../background/service-worker.js'), 'utf8');
  const listenerSource = background.slice(background.indexOf('chrome.storage.onChanged.addListener'), background.indexOf('chrome.runtime.onMessage.addListener'));
  let listener;
  const injected = [];
  const context = {
    chrome: {
      storage: { onChanged: { addListener: callback => { listener = callback; } } },
      tabs: { query: async () => [
        { id: 1, url: 'https://example.com/' },
        { id: 2, url: 'http://example.org/' },
        { id: 3, url: 'chrome://settings/' },
        { id: 4, url: 'file:///tmp/example.html' }
      ] },
      scripting: { executeScript: async options => { injected.push(options); } }
    }
  };
  vm.runInNewContext(listenerSource, context);
  listener({ 'moduleEnabled:dark-mode': { newValue: true } }, 'local');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(injected.map(item => item.target.tabId), [1, 2, 4]);
  assert.ok(injected.every(item => item.files[0] === 'content/dark-mode.js'));
  listener({ 'moduleEnabled:dark-mode': { newValue: false } }, 'local');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(injected.length, 3);
  listener({ darkModeSites: { newValue: ['example.com'] } }, 'local');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(injected.length, 6);
});
