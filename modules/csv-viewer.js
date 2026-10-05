// A `text/csv` response never becomes a page: Chrome hands it straight to the downloader,
// so the navigation aborts and no content script ever runs. Relabeling the response as
// plain text — and dropping the attachment disposition that would download it regardless —
// is what puts a document on screen for content/csv-viewer.js to turn into a table.
const ENABLED_KEY = 'moduleEnabled:csv-viewer';
// Clear of the ad blocker's dynamic block of ids, which runs from 1000000.
const RULE_ID = 1100000;
let queue = Promise.resolve();

export const viewerRule = {
  id: RULE_ID,
  // An `allowAllRequests` rule outranks a header rule of lower priority, and the ad
  // blocker writes one of those at priority 1000000 for every site it is paused on.
  // Sitting above them keeps CSVs readable on a site whose ads are not being blocked.
  priority: 2000000,
  action: {
    type: 'modifyHeaders',
    responseHeaders: [
      // UTF-8 is the encoding a CSV is written in often enough to be the useful default;
      // a file in a legacy single-byte encoding is what "Raw text" is there for.
      { header: 'content-type', operation: 'set', value: 'text/plain; charset=utf-8' },
      { header: 'content-disposition', operation: 'remove' }
    ]
  },
  condition: {
    // The extension has to be in the path or the query — a CSV served from an opaque URL
    // is indistinguishable from any other download before its headers arrive.
    regexFilter: '^https?://[^#]*\\.(?:csv|tsv)(?:[?#]|$)',
    // Only a navigation. A page's own fetch of a CSV must keep the type it asked for.
    resourceTypes: ['main_frame']
  }
};

// Chrome echoes a dynamic rule back with its own defaults filled in, so only the fields
// this module sets are compared.
const ruleShape = rule => JSON.stringify([
  rule?.priority, rule?.action?.type, rule?.action?.responseHeaders,
  rule?.condition?.regexFilter, rule?.condition?.resourceTypes
]);

async function reconcile() {
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  const enabled = stored[ENABLED_KEY] !== false;
  const existing = (await chrome.declarativeNetRequest.getDynamicRules()).find(rule => rule.id === RULE_ID);
  if (!enabled) {
    if (existing) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] });
    return { enabled };
  }
  // A dynamic rule outlives the service worker, so one written by an earlier version is
  // replaced rather than left in place beside the current shape.
  if (ruleShape(existing) !== ruleShape(viewerRule)) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID], addRules: [viewerRule] });
  }
  return { enabled };
}

function enqueue(task) {
  const next = queue.then(task);
  queue = next.catch(error => console.error('CSV viewer:', error));
  return next;
}

export function initializeCsvViewer() {
  chrome.runtime.onInstalled.addListener(() => { void enqueue(reconcile); });
  chrome.runtime.onStartup.addListener(() => { void enqueue(reconcile); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[ENABLED_KEY]) void enqueue(reconcile);
  });
  void enqueue(reconcile);
}
