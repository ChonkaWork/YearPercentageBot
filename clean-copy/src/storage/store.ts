import { sanitizeLastCopy, type LastCopy } from '../core/lastCopy';
import { sanitizePlan, type Plan } from '../core/plan';
import { sanitizeRules, type Rule } from '../core/rules';
import { defaultSettings, sanitizeSettings, type Settings } from '../core/settings';
import { sanitizeSites } from '../core/sites';
import type { ToastMessage } from '../page/toast';

/**
 * Everything lives in chrome.storage.local (this browser only, never synced) and is
 * sanitized on read. chrome.storage.session (memory only, cleared when the browser closes,
 * not readable by content scripts) holds the last clean copy (for Undo and "Show changes"),
 * the last notice from the background (when it couldn't show a toast in the page) until the
 * popup shows it, and a short-lived "clean the clipboard once access is granted" flag.
 */

export const KEYS = { settings: 'settings', rules: 'rules', sites: 'sites', allSites: 'allSites', plan: 'plan' } as const;
const NOTICE_KEY = 'notice';
const NOTICE_MAX_AGE_MS = 10 * 60 * 1000;
export const LAST_COPY_KEY = 'lastCopy';
const PENDING_CLIPBOARD_KEY = 'pendingClipboard';
const PENDING_MAX_AGE_MS = 2 * 60 * 1000;

export interface State {
  settings: Settings;
  rules: Rule[];
  sites: string[];
  /** Auto-clean on every site (Pro), with the optional all-sites permission. */
  allSites: boolean;
  plan: Plan;
}

export function stateFrom(data: Record<string, unknown>): State {
  return {
    settings: sanitizeSettings(data[KEYS.settings]),
    rules: sanitizeRules(data[KEYS.rules]),
    sites: sanitizeSites(data[KEYS.sites]),
    allSites: data[KEYS.allSites] === true,
    plan: sanitizePlan(data[KEYS.plan]),
  };
}

export async function loadState(): Promise<State> {
  try {
    return stateFrom(await chrome.storage.local.get(Object.values(KEYS)));
  } catch {
    return { settings: defaultSettings(), rules: [], sites: [], allSites: false, plan: 'free' };
  }
}

export async function saveAllSites(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.allSites]: on });
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

// --- Last copy (session) -----------------------------------------------------------------------

/** Keeps the copy, replacing the previous one. Too large for storage: kept without extras, or not at all. */
export async function saveLastCopy(copy: LastCopy): Promise<void> {
  try {
    await chrome.storage.session.set({ [LAST_COPY_KEY]: copy });
    return;
  } catch {
    // Quota: try without the HTML and the changes.
  }
  const { changes: _changes, ...slim } = copy;
  if (slim.original?.html) slim.original = { text: slim.original.text };
  try {
    await chrome.storage.session.set({ [LAST_COPY_KEY]: slim });
  } catch {
    await clearLastCopy();
  }
}

export async function loadLastCopy(): Promise<LastCopy | null> {
  try {
    return sanitizeLastCopy((await chrome.storage.session.get(LAST_COPY_KEY))[LAST_COPY_KEY]);
  } catch {
    return null;
  }
}

export async function clearLastCopy(): Promise<void> {
  try {
    await chrome.storage.session.remove(LAST_COPY_KEY);
  } catch {
    // Nothing kept.
  }
}

/** The popup is about to ask for clipboard access: clean the clipboard once it's granted. */
export function setPendingClipboardClean(): Promise<void> {
  return chrome.storage.session.set({ [PENDING_CLIPBOARD_KEY]: Date.now() });
}

/** Reads and clears the flag; true when it was set in the last two minutes. */
export async function takePendingClipboardClean(): Promise<boolean> {
  try {
    const value = (await chrome.storage.session.get(PENDING_CLIPBOARD_KEY))[PENDING_CLIPBOARD_KEY];
    if (value === undefined) return false;
    await chrome.storage.session.remove(PENDING_CLIPBOARD_KEY);
    return typeof value === 'number' && Date.now() - value < PENDING_MAX_AGE_MS;
  } catch {
    return false;
  }
}
