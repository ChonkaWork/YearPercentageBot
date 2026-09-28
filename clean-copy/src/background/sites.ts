import { limitsFor } from '../core/plan';
import { activeSites, hostFromPattern, originPattern } from '../core/sites';
import { loadState } from '../storage/store';

/**
 * Keeps the auto-clean content script registration in line with the sites list and the
 * granted permissions: registered for exactly the sites that are in the list AND granted,
 * unregistered when there are none. Called on startup, when the list or the plan changes,
 * and when a permission is added or removed (also from chrome://extensions).
 */

export const AUTO_CLEAN_SCRIPT_ID = 'clean-copy-auto-clean';
const SCRIPT_FILE = 'autoclean.js';

let queue: Promise<unknown> = Promise.resolve();

/** Serialized: overlapping calls (events arrive in bursts) run one after another. */
export function syncAutoClean(): Promise<string[]> {
  const run = queue.then(doSync, doSync);
  queue = run.catch(() => undefined);
  return run;
}

async function doSync(): Promise<string[]> {
  const state = await loadState();
  const { origins = [] } = await chrome.permissions.getAll();
  const active = activeSites(state.sites, origins).slice(0, limitsFor(state.plan).maxSites);
  const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_CLEAN_SCRIPT_ID] });

  if (active.length === 0) {
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_CLEAN_SCRIPT_ID] });
    return [];
  }

  const script: chrome.scripting.RegisteredContentScript = {
    id: AUTO_CLEAN_SCRIPT_ID,
    js: [SCRIPT_FILE],
    matches: active.map(originPattern),
    allFrames: true,
    runAt: 'document_start',
    persistAcrossSessions: true,
  };
  if (existing) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);

  // Tabs that were already open on a newly enabled site get the script now, no reload needed.
  const before = new Set((existing?.matches ?? []).map(hostFromPattern));
  for (const host of active.filter((site) => !before.has(site))) {
    const tabs = await chrome.tabs.query({ url: originPattern(host) }).catch(() => []);
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: [SCRIPT_FILE] }).catch(() => undefined);
    }
  }
  return active;
}
