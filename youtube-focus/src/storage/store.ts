import type { Access } from '../core/focus';
import { EARLY_ACCESS, hasFeature, PLAN_KEY, sanitizePlan, type ProFeature } from '../core/plan';
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

/** Read-modify-write, so a change from the popup doesn't drop one made in Settings. */
export async function updateSettings(change: (current: Settings) => Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = sanitizeSettings({ ...current, ...change(current) });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return updateSettings(() => patch);
}

// --- Plan -------------------------------------------------------------------------------------

/** Only in the e2e build: lets the test turn early access off to check the free plan. */
const E2E_EARLY_ACCESS_KEY = __E2E__ ? 'e2e:earlyAccess' : '';

export async function loadAccess(): Promise<Access> {
  const keys = __E2E__ ? [PLAN_KEY, E2E_EARLY_ACCESS_KEY] : [PLAN_KEY];
  const data = await chrome.storage.local.get(keys);
  let earlyAccess = EARLY_ACCESS;
  if (__E2E__ && typeof data[E2E_EARLY_ACCESS_KEY] === 'boolean') earlyAccess = data[E2E_EARLY_ACCESS_KEY];
  return { plan: sanitizePlan(data[PLAN_KEY]), earlyAccess };
}

/** Whether a storage change can change what the plan includes. */
export function isAccessChange(changes: Record<string, unknown>): boolean {
  return PLAN_KEY in changes || (__E2E__ && E2E_EARLY_ACCESS_KEY in changes);
}

export function can(access: Access, feature: ProFeature): boolean {
  return hasFeature(access.plan, feature, access.earlyAccess);
}
