import { sanitizePlan, type Plan } from '../core/plan';
import { sanitizeRules, type Rule } from '../core/rules';
import { defaultSettings, sanitizeSettings, type Settings } from '../core/settings';
import { sanitizeSites } from '../core/sites';
import type { ToastMessage } from '../page/toast';

/**
 * Everything lives in chrome.storage.local (this browser only, never synced) and is
 * sanitized on read. The last notice from the background (when it couldn't show a toast in
 * the page) lives in chrome.storage.session until the popup shows it.
 */

export const KEYS = { settings: 'settings', rules: 'rules', sites: 'sites', plan: 'plan' } as const;
const NOTICE_KEY = 'notice';
const NOTICE_MAX_AGE_MS = 10 * 60 * 1000;

export interface State {
  settings: Settings;
  rules: Rule[];
  sites: string[];
  plan: Plan;
}

export function stateFrom(data: Record<string, unknown>): State {
  return {
    settings: sanitizeSettings(data[KEYS.settings]),
    rules: sanitizeRules(data[KEYS.rules]),
    sites: sanitizeSites(data[KEYS.sites]),
    plan: sanitizePlan(data[KEYS.plan]),
  };
}

export async function loadState(): Promise<State> {
  try {
    return stateFrom(await chrome.storage.local.get(Object.values(KEYS)));
  } catch {
    return { settings: defaultSettings(), rules: [], sites: [], plan: 'free' };
  }
}

export async function loadSettings(): Promise<Settings> {
  return (await loadState()).settings;
}

/** Throws when storage is unavailable, so callers can tell the user the change wasn't saved. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}

export async function saveRules(rules: readonly Rule[]): Promise<Rule[]> {
  const next = sanitizeRules(rules);
  await chrome.storage.local.set({ [KEYS.rules]: next });
  return next;
}

export async function saveSites(sites: readonly string[]): Promise<string[]> {
  const next = sanitizeSites(sites);
  await chrome.storage.local.set({ [KEYS.sites]: next });
  return next;
}

export interface StoredNotice extends ToastMessage {
  createdAt: number;
}

export async function setNotice(message: ToastMessage): Promise<void> {
  await chrome.storage.session.set({ [NOTICE_KEY]: { ...message, createdAt: Date.now() } });
}

/** Reads and clears the pending notice. Stale or malformed entries are ignored. */
export async function takeNotice(): Promise<StoredNotice | null> {
  try {
    const data = await chrome.storage.session.get(NOTICE_KEY);
    await chrome.storage.session.remove(NOTICE_KEY);
    const value = data[NOTICE_KEY] as Partial<StoredNotice> | undefined;
    if (!value || typeof value.title !== 'string' || typeof value.createdAt !== 'number') return null;
    if (Date.now() - value.createdAt > NOTICE_MAX_AGE_MS) return null;
    const tone = value.tone === 'success' || value.tone === 'info' ? value.tone : 'error';
    const notice: StoredNotice = { tone, title: value.title, createdAt: value.createdAt };
    if (typeof value.detail === 'string') notice.detail = value.detail;
    return notice;
  } catch {
    return null;
  }
}
