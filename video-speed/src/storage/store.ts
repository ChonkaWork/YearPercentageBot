import {
  GLOBAL_SPEED_KEY,
  isSpeedKey,
  MAX_SITE_SPEEDS,
  parseGlobalSpeed,
  parseSiteSpeed,
  siteKeysToPrune,
  siteSpeedKey,
  type RememberedSpeeds,
} from '../core/memory';
import { sanitizeSettings, type Settings } from '../core/settings';

/**
 * chrome.storage.local wrappers. Everything stays in this browser profile; nothing is synced
 * or sent anywhere. Reads and writes throw when storage is unavailable so callers can tell
 * the user.
 */

export const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(data[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings(): Promise<void> {
  await chrome.storage.local.remove(SETTINGS_KEY);
}

export async function loadRememberedSpeeds(host: string): Promise<RememberedSpeeds> {
  const keys = host ? [GLOBAL_SPEED_KEY, siteSpeedKey(host)] : [GLOBAL_SPEED_KEY];
  const data = await chrome.storage.local.get(keys);
  return {
    global: parseGlobalSpeed(data[GLOBAL_SPEED_KEY]),
    site: host ? parseSiteSpeed(data[siteSpeedKey(host)]) : null,
  };
}

/**
 * Saves the last-used speed globally, and for the site when per-site memory is on.
 * `newSite` (first entry for this host) triggers pruning of the oldest site entries.
 */
export async function saveRememberedSpeed(speed: number, host: string, perSite: boolean, newSite: boolean): Promise<void> {
  const items: Record<string, unknown> = { [GLOBAL_SPEED_KEY]: speed };
  if (perSite && host) items[siteSpeedKey(host)] = { speed, at: Date.now() };
  await chrome.storage.local.set(items);
  if (perSite && host && newSite) await pruneSiteSpeeds();
}

async function pruneSiteSpeeds(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const stale = siteKeysToPrune(all, MAX_SITE_SPEEDS);
  if (stale.length) await chrome.storage.local.remove(stale);
}

/** Forgets every remembered speed. Returns how many sites had one. */
export async function clearRememberedSpeeds(): Promise<number> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(isSpeedKey);
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.filter((key) => key !== GLOBAL_SPEED_KEY).length;
}

export async function countSiteSpeeds(): Promise<number> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((key) => key !== GLOBAL_SPEED_KEY && isSpeedKey(key)).length;
}
