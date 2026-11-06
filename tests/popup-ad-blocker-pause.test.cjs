const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { popupPage, adBlockerWorker } = require('./popup-dom.cjs');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('the per-site ad blocker button sits beside the other site controls', () => {
  const html = read('popup/popup.html');
  assert.match(html, /<button id="ad-blocker-pause-toggle" type="button" aria-pressed="false" disabled>Disable here<\/button>/);
  // The current-site action and the bulk exception editor stay together; cookie settings
  // remain a separate site control.
  assert.ok(html.indexOf('ad-blocker-pause-toggle') < html.indexOf('cookie-pause-toggle'));
  assert.ok(html.indexOf('ad-blocker-pause-toggle') < html.indexOf('<summary>More site exceptions</summary>'));
  assert.ok(html.indexOf('<summary>More site exceptions</summary>') < html.indexOf('cookie-pause-toggle'));
  assert.match(read('popup/popup.js'), /aria-pressed/);
});

function open({ sites = [], url = 'https://example.com/', worker = adBlockerWorker(sites) } = {}) {
  const view = popupPage({
    tab: url === null ? { id: 7, url: 'chrome://extensions' } : { id: 7, url },
    sendMessage: message => worker.handle(message)
  });
  return { view, worker, toggle: view.byId('ad-blocker-pause-toggle'), settle: view.settle };
}

async function flip(page) {
  page.toggle.dispatch('click');
  await page.settle();
}

test('the switch starts off, and comes back on for a site that is already paused', async () => {
  const fresh = open();
  await fresh.settle();
  assert.equal(fresh.toggle.textContent, 'Disable here', 'nothing is paused by default');
  assert.equal(fresh.toggle.disabled, false);
  assert.equal(fresh.toggle.title, 'example.com');

  // The selection is remembered because it is read back out of the stored list on open,
  // not held in the popup that set it.
  const remembered = open({ sites: ['example.com'] });
  await remembered.settle();
  assert.equal(remembered.toggle.textContent, 'Enable here');
  assert.equal(remembered.view.byId('ad-blocker-sites').value, 'example.com');
});

test('flipping it on pauses this site, and off takes it back off the list', async () => {
  const page = open();
  await page.settle();

  await flip(page);
  assert.deepEqual(page.worker.sites, ['example.com']);
  assert.equal(page.toggle.textContent, 'Enable here');
  assert.equal(page.view.byId('ad-blocker-sites').value, 'example.com', 'the bulk list follows the switch');
  assert.match(page.view.byId('status').textContent, /^Ad blocker paused on example\.com\./);

  await flip(page);
  assert.deepEqual(page.worker.sites, []);
  assert.equal(page.toggle.textContent, 'Disable here');
  assert.equal(page.view.byId('ad-blocker-sites').value, '');
  assert.match(page.view.byId('status').textContent, /^Ad blocker resumed on example\.com\./);
});

test('on a subdomain of a paused site the switch reads the truth, and says what resuming costs', async () => {
  // A paused entry covers its subdomains, so blocking really is off here. A switch showing
  // unchecked would be telling the user the opposite of what is happening.
  const page = open({ sites: ['example.com'], url: 'https://news.example.com/story' });
  await page.settle();
  assert.equal(page.toggle.textContent, 'Enable here');
  assert.equal(page.toggle.title, 'news.example.com');

  // Resuming has to clear the entry that reaches this host, or the switch would snap back
  // on and the flip would read as having done nothing. That entry is the parent, so its
  // other subdomains lose their pause too -- which the status line says out loud.
  await flip(page);
  assert.deepEqual(page.worker.sites, []);
  assert.equal(page.toggle.textContent, 'Disable here');
  assert.equal(page.view.byId('status').textContent,
    'Ad blocker resumed on news.example.com. This removed example.com, so their other subdomains are no longer paused either.');
});

test('a site paused under its own name leaves its siblings alone', async () => {
  const page = open({ sites: ['example.com', 'news.example.com', 'other.test'], url: 'https://news.example.com/' });
  await page.settle();
  assert.equal(page.toggle.textContent, 'Enable here');

  // Both example.com and news.example.com reach this host and both have to go, but a
  // site that never covered it is not the switch's business.
  await flip(page);
  assert.deepEqual(page.worker.sites, ['other.test']);
  assert.equal(page.toggle.textContent, 'Disable here');
});

test('a refused write leaves the switch showing what is actually stored', async () => {
  const page = open();
  await page.settle();
  page.worker.refuse = 'Enter up to 200 sites.';

  await flip(page);
  // Nothing reverts the box by hand: it is redrawn from the list that came back, and a
  // refused write never changed that list.
  assert.equal(page.toggle.textContent, 'Disable here', 'the switch must not claim a pause that was refused');
  assert.deepEqual(page.worker.sites, []);
  assert.equal(page.view.byId('status').textContent, 'Enter up to 200 sites.');
  assert.equal(page.toggle.disabled, false, 'and it stays usable for a second try');

  // With the refusal lifted, the same flip goes through.
  page.worker.refuse = null;
  await flip(page);
  assert.deepEqual(page.worker.sites, ['example.com']);
  assert.equal(page.toggle.textContent, 'Enable here');
});

test('the switch follows a pause made somewhere else', async () => {
  const page = open();
  await page.settle();
  assert.equal(page.toggle.textContent, 'Disable here');

  // Another window, or the worker itself after an import. The popup has to follow storage
  // it did not write, or it would sit there contradicting it.
  page.view.changed({ adBlockerPausedSites: { newValue: ['example.com'] } });
  assert.equal(page.toggle.textContent, 'Enable here');
  assert.equal(page.view.byId('ad-blocker-sites').value, 'example.com');

  page.view.changed({ adBlockerPausedSites: { newValue: [] } });
  assert.equal(page.toggle.textContent, 'Disable here');

  // A change in another area is not this popup's storage.
  page.view.changed({ adBlockerPausedSites: { newValue: ['example.com'] } }, 'sync');
  assert.equal(page.toggle.textContent, 'Disable here');
});

test('the bulk list keeps what the user is typing, and the switch still reflects it', async () => {
  const page = open();
  await page.settle();
  const editor = page.view.byId('ad-blocker-sites');
  editor.value = 'half-typed.exa';
  page.view.document.activeElement = editor;

  // Overwriting the textarea mid-sentence would lose the line being written, so an
  // external change updates the switch but leaves the field alone.
  page.view.changed({ adBlockerPausedSites: { newValue: ['example.com'] } });
  assert.equal(editor.value, 'half-typed.exa');
  assert.equal(page.toggle.textContent, 'Enable here');

  // Saving the list by hand is the other way in, and the switch answers for it too.
  page.view.document.activeElement = null;
  editor.value = 'example.com\nother.test';
  page.view.byId('save-ad-blocker-sites').dispatch('click');
  await page.settle();
  assert.deepEqual(page.worker.sites, ['example.com', 'other.test']);
  assert.equal(page.toggle.textContent, 'Enable here');
});

test('a page with no site of its own leaves the switch off and out of reach', async () => {
  // chrome:// pages have no host to pause, and the switch says so rather than offering a
  // flip that could not do anything.
  const page = open({ url: null });
  await page.settle();
  assert.equal(page.toggle.disabled, true);
  assert.equal(page.toggle.textContent, 'Disable here');
  assert.equal(page.toggle.title, 'Available on website tabs');

  // Even if something did flip it, there is no site to write and the list is untouched.
  await flip(page);
  assert.deepEqual(page.worker.sites, []);
  assert.equal(page.toggle.textContent, 'Disable here');
});
