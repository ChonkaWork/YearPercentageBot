import { limitsFor } from '../core/plan';
import { ALL_SITES_PATTERN, autoCleanScope, hostFromPattern, originPattern, type AutoCleanScope } from '../core/sites';
import { loadState } from '../storage/store';
import { refreshBadges } from './badge';

/**
 * Keeps the auto-clean content script registration in line with the sites list, the "All
 * sites" switch and the granted permissions: registered for exactly the sites that are in the
 * list AND granted (or for every site when "All sites" is on and granted), unregistered when
 * there are none. Called on startup, when the list, the switch or the plan changes, and when
 * a permission is added or removed (also from chrome://extensions).
 */

export const AUTO_CLEAN_SCRIPT_ID = 'clean-copy-auto-clean';
const SCRIPT_FILE = 'autoclean.js';

let queue: Promise<unknown> = Promise.resolve();

/** Serialized: overlapping calls (events arrive in bursts) run one after another. */
export function syncAutoClean(): Promise<AutoCleanScope> {
  const run = queue.then(doSync, doSync);
  queue = run.catch(() => undefined);
  return run;
}

/** Where auto-clean is active right now (for the toolbar badge). */
export async function currentScope(): Promise<AutoCleanScope> {
  const state = await loadState();
  const { origins = [] } = await chrome.permissions.getAll();
  return autoCleanScope({ sites: state.sites, allSites: state.allSites, granted: origins, maxSites: limitsFor(state.plan).maxSites });
}

async function doSync(): Promise<AutoCleanScope> {
  const scope = await currentScope();
  const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_CLEAN_SCRIPT_ID] });

  if (!scope.all && scope.hosts.length === 0) {
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_CLEAN_SCRIPT_ID] });
    await refreshBadges(scope);
    return scope;
  }

  const script: chrome.scripting.RegisteredContentScript = {
    id: AUTO_CLEAN_SCRIPT_ID,
    js: [SCRIPT_FILE],
    matches: scope.all ? [ALL_SITES_PATTERN] : scope.hosts.map(originPattern),
    allFrames: true,
    runAt: 'document_start',
    persistAcrossSessions: true,
  };
  if (existing) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);

  // Tabs that were already open on a newly enabled site get the script now, no reload needed
  // (the script ignores a second injection).
  const before = existing?.matches ?? [];
  const patterns = scope.all
    ? before.includes(ALL_SITES_PATTERN)
      ? []
      : [ALL_SITES_PATTERN]
    : scope.hosts.filter((site) => !before.map(hostFromPattern).includes(site)).map(originPattern);
  for (const pattern of patterns) {
    const tabs = await chrome.tabs.query({ url: pattern }).catch(() => []);
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: [SCRIPT_FILE] }).catch(() => undefined);
    }
  }
  await refreshBadges(scope);
  return scope;
}
