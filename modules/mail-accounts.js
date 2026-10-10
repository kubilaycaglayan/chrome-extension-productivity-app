import { isModuleEnabled } from "./settings.js";

// Gmail shortcuts for the New Tab page, which shows one button per Google
// account this profile is signed into. Chrome hands an extension no way to
// list those accounts: the only name an account has is the index Gmail keeps
// in its own address, /mail/u/1/ being the second account signed in. So the
// list is discovered here, out of traffic the browser makes anyway --
//   * every Gmail tab the user opens names an account in its URL, and
//   * at most twice a day each index is asked where it lands --
// and left in storage for the page to read. The page never probes for itself,
// which is what keeps opening a new tab free of network calls.
//
// The constants below are the ones `newtabSettings.mail` declares for the
// page; the page cannot import a worker module, so tests/mail-accounts.test.cjs
// holds the two copies to each other instead.
const KEY = "newtabMailAccounts";
const ORIGIN = "https://mail.google.com";
const MAX_ACCOUNTS = 6;
const CACHE_MAX_AGE = 12 * 60 * 60 * 1000;
const SLOT = /^\/mail\/u\/(\d+)(?:\/|$)/;

const inRange = slot => Number.isInteger(slot) && slot >= 0 && slot < MAX_ACCOUNTS;

function slotFromUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN) return null;
  const slot = Number(url.pathname.match(SLOT)?.[1]);
  return inRange(slot) ? slot : null;
}

async function read() {
  let stored;
  try {
    stored = (await chrome.storage.local.get(KEY))[KEY];
  } catch {
    stored = null;
  }
  return {
    accounts: (Array.isArray(stored?.accounts) ? stored.accounts : []).filter(inRange),
    checkedAt: Number.isFinite(stored?.checkedAt) ? stored.checkedAt : 0
  };
}

async function write(accounts, checkedAt) {
  const slots = [...new Set(accounts)].sort((a, b) => a - b).slice(0, MAX_ACCOUNTS);
  try {
    await chrome.storage.local.set({ [KEY]: { accounts: slots, checkedAt } });
  } catch {
    // Nothing to fall back on: the page shows its single shortcut.
  }
}

// A Gmail tab is proof that the account behind its index exists right now, so
// this only ever adds. Noticing one that has gone is the probe's job.
async function remember(slot) {
  const { accounts, checkedAt } = await read();
  if (accounts.includes(slot)) return;
  await write([...accounts, slot], checkedAt);
}

// Walks the indices in order and stops at the first one Gmail will not keep.
// Chrome numbers accounts consecutively as they sign in, so a refused index is
// the end of the list rather than a gap to step over. Returns null when Gmail
// could not be reached at all, which is different from finding nobody.
async function probe() {
  const found = [];
  for (let slot = 0; slot < MAX_ACCOUNTS; slot += 1) {
    let response;
    try {
      // HEAD, so an answer costs headers instead of an inbox. The cookies are
      // the whole question being asked, which is why they are sent.
      response = await fetch(`${ORIGIN}/mail/u/${slot}/`, {
        method: "HEAD",
        credentials: "include",
        cache: "no-store",
        redirect: "follow"
      });
    } catch {
      return null;
    }
    // A signed-in index stays on its own URL. One nobody is signed into is
    // sent to the login page, the account chooser, or another index.
    if (slotFromUrl(response.url) !== slot) break;
    found.push(slot);
  }
  return found;
}

async function refresh(force) {
  if (!await isModuleEnabled("newtab")) return;
  const { checkedAt } = await read();
  if (!force && Date.now() - checkedAt < CACHE_MAX_AGE) return;
  const found = await probe();
  if (!found) return;
  // An empty answer means signed out of Google altogether. That is a real
  // answer: the page falls back to the single unnumbered Gmail shortcut.
  await write(found, Date.now());
}

export function initializeMailAccounts() {
  // Storage round trips interleave, so the reads and writes queue up rather
  // than racing a later Gmail visit against an earlier probe.
  let pending = Promise.resolve();
  const enqueue = work => {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  };

  chrome.runtime.onStartup.addListener(() => enqueue(() => refresh(false)));
  // A fresh install has nothing stored, and an update is a good moment to
  // re-ask: the list is cheap to rebuild and may be months old.
  chrome.runtime.onInstalled.addListener(() => enqueue(() => refresh(true)));

  // Chrome ignores what a tab listener returns; the queued work is handed back
  // so a caller that wants to wait for it -- the tests -- can.
  chrome.tabs.onUpdated.addListener((tabId, changes) => {
    const slot = slotFromUrl(changes.url);
    // Nearly every update is a title or a favicon somewhere else entirely.
    return slot === null ? Promise.resolve() : enqueue(async () => {
      if (!await isModuleEnabled("newtab")) return;
      await remember(slot);
      // The user is in Gmail, which is where accounts are added and dropped,
      // so a stale list is at its most worth re-asking. The age guard holds.
      await refresh(false);
    });
  });
}
