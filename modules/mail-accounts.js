import { isModuleEnabled } from "./settings.js";

// Gmail shortcuts for the New Tab page, which shows one button per Google
// account this profile is signed into. Chrome hands an extension no API for
// that list, but it keeps one itself: the avatar menu and Gmail's own account
// switcher are both painted from accounts.google.com/ListAccounts. That answer
// carries every account the cookie jar remembers, each with its email and two
// flags -- whether its session is still valid, and whether it was signed out
// and is only being remembered for "continue as". Only the ones Gmail would
// open straight into are worth a button, so those two flags are the filter.
//
// The list is fetched here and left in storage for the page to read. The page
// never fetches for itself, which keeps opening a new tab free of network
// calls; it only nudges this worker, which decides whether the list is stale.
//
// The constants below are the ones `newtabSettings.mail` declares for the
// page; the page cannot import a worker module, so tests/mail-accounts.test.cjs
// holds the two copies to each other instead.
const KEY = "newtabMailAccounts";
const MAX_ACCOUNTS = 6;
const CACHE_MAX_AGE = 12 * 60 * 60 * 1000;
// A nudge -- a new tab, a Gmail visit, a sign-in page -- re-asks once the list
// is older than this, so signing in or out shows up within a tab or two.
const NUDGE_MAX_AGE = 60 * 1000;
const LIST_URL = "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard";
const REFRESH_MESSAGE = "mail-accounts:refresh";
// Google refuses ListAccounts from a chrome-extension:// Origin, the way it
// refuses any cross-site caller. Chrome's own request carries no Origin at
// all, so this session rule strips it from this extension's request alone.
const ORIGIN_RULE_ID = 1200000;
const ORIGIN_RULE = {
  id: ORIGIN_RULE_ID,
  priority: 1,
  action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
  condition: {
    urlFilter: "|https://accounts.google.com/ListAccounts",
    initiatorDomains: [chrome.runtime.id],
    resourceTypes: ["xmlhttprequest"]
  }
};
// Where accounts are added and dropped, so a visit there is worth a re-ask.
const ACCOUNT_PAGES = /^https:\/\/(?:mail|accounts)\.google\.com\//;

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+$/;

// ListAccounts answers `["gaia.l.a.r", [account, ...]]`, each account a
// positional array: [3] the email, [2] the display name, [9] 0 when the
// session has expired, [14] 1 when the account was signed out. Chromium reads
// the same fields (gaia_auth_util.cc), and an absent flag means the old,
// signed-in shape. Returns null for anything that is not that answer.
export function parseListAccounts(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\)\]\}'\s*/, ""));
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data[0] !== "gaia.l.a.r" || !Array.isArray(data[1])) return null;
  const accounts = [];
  for (const entry of data[1]) {
    if (!Array.isArray(entry)) continue;
    const email = typeof entry[3] === "string" ? entry[3].trim() : "";
    if (!EMAIL.test(email)) continue;
    if (entry[9] === 0 || entry[14]) continue;
    if (accounts.some(account => account.email.toLowerCase() === email.toLowerCase())) continue;
    const name = typeof entry[2] === "string" ? entry[2].trim().slice(0, 80) : "";
    accounts.push(name ? { email, name } : { email });
  }
  return accounts.slice(0, MAX_ACCOUNTS);
}

async function readCheckedAt() {
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY];
    return Number.isFinite(stored?.checkedAt) ? stored.checkedAt : 0;
  } catch {
    return 0;
  }
}

async function allowRequest() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ORIGIN_RULE_ID], addRules: [ORIGIN_RULE] });
  } catch {
    // Without the rule Google answers 403, which the caller treats as unreachable.
  }
}

// Returns the signed-in accounts, or null when Google could not be asked or
// answered something other than the list -- which is different from an empty
// list, the real answer for a profile signed out of everything.
async function listAccounts() {
  await allowRequest();
  try {
    const response = await fetch(LIST_URL, {
      method: "POST",
      body: " ",
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) return null;
    return parseListAccounts(await response.text());
  } catch {
    return null;
  }
}

async function refresh(maxAge) {
  if (!await isModuleEnabled("newtab")) return;
  if (Date.now() - await readCheckedAt() < maxAge) return;
  const accounts = await listAccounts();
  if (!accounts) return;
  try {
    await chrome.storage.local.set({ [KEY]: { accounts, checkedAt: Date.now() } });
  } catch {
    // Nothing to fall back on: the page keeps what it last showed.
  }
}

export function initializeMailAccounts() {
  // Overlapping nudges would each find the list stale and ask twice, so the
  // work queues and the second one sees the first one's stamp.
  let pending = Promise.resolve();
  const enqueue = work => {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  };

  chrome.runtime.onStartup.addListener(() => enqueue(() => refresh(CACHE_MAX_AGE)));
  // A fresh install has nothing stored, and an update may have changed what
  // is stored, so both re-ask whatever the stamp says.
  chrome.runtime.onInstalled.addListener(() => enqueue(() => refresh(0)));

  // Chrome ignores what a tab listener returns; the queued work is handed back
  // so a caller that wants to wait for it -- the tests -- can.
  chrome.tabs.onUpdated.addListener((tabId, changes) => {
    // Nearly every update is a title or a favicon somewhere else entirely.
    if (!ACCOUNT_PAGES.test(String(changes.url ?? ""))) return Promise.resolve();
    return enqueue(() => refresh(NUDGE_MAX_AGE));
  });

  // A new tab opening is the moment the list is about to be looked at.
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === REFRESH_MESSAGE) void enqueue(() => refresh(NUDGE_MAX_AGE));
  });
}
