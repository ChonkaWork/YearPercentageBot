import { activeSites, originPattern, sanitizeSites } from '../core/sites';
import type { SyncRequest } from '../platform/messages';
import { KEYS, saveSites } from '../storage/store';

/**
 * Adding and removing auto-clean sites from the popup and the options page. A permission
 * prompt needs the click that caused it, so chrome.permissions.request is the first thing a
 * click handler awaits.
 */

export interface SiteStatus {
  host: string;
  /** Permission granted and the content script registered for it. */
  active: boolean;
}

export async function siteStatuses(sites: readonly string[]): Promise<SiteStatus[]> {
  let origins: string[] = [];
  try {
    origins = (await chrome.permissions.getAll()).origins ?? [];
  } catch {
    // Treated as "needs permission".
  }
  const active = new Set(activeSites(sites, origins));
  return sites.map((host) => ({ host, active: active.has(host) }));
}

/** Ask the background to (un)register the content script now instead of on its next event. */
export async function requestSync(): Promise<void> {
  try {
    const request: SyncRequest = { type: 'cc/sync-sites' };
    await chrome.runtime.sendMessage(request);
  } catch {
    // The background also syncs on permission and storage events.
  }
}

/**
 * Adds a site and asks for access to it. The list is written before the prompt opens, so the
 * site isn't lost if the popup closes while the prompt is showing (the background finishes
 * the job when the permission arrives). A refused prompt takes the site out again.
 */
export async function addSite(host: string, sites: readonly string[]): Promise<boolean> {
  const next = sanitizeSites([...sites, host]);
  const saving = chrome.storage.local.set({ [KEYS.sites]: next });
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern(host)] });
  } catch {
    granted = false;
  }
  await saving;
  if (!granted) {
    await saveSites(next.filter((site) => site !== host || sites.includes(site)));
    return false;
  }
  await requestSync();
  return true;
}

/** Asks again for a site that is listed but not granted. */
export async function grantSite(host: string): Promise<boolean> {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern(host)] });
  } catch {
    granted = false;
  }
  await requestSync();
  return granted;
}

/** Removes a site: stops auto-clean there and gives the permission back. */
export async function removeSite(host: string, sites: readonly string[]): Promise<string[]> {
  const next = await saveSites(sites.filter((site) => site !== host));
  try {
    await chrome.permissions.remove({ origins: [originPattern(host)] });
  } catch {
    // Required permissions (only in the e2e build) can't be removed; nothing else to do.
  }
  await requestSync();
  return next;
}
