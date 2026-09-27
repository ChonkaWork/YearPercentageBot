import { defaultSettings, sanitizeSettings, type Settings } from '../core/settings';
import type { ToastMessage } from '../page/toast';

/**
 * Settings live in chrome.storage.local (this browser only, never synced). The last
 * notice from the background (when it couldn't show a toast in the page) lives in
 * chrome.storage.session until the popup shows it.
 */

const SETTINGS_KEY = 'settings';
const NOTICE_KEY = 'notice';
const NOTICE_MAX_AGE_MS = 10 * 60 * 1000;

function localeDefaults(): Settings {
  return defaultSettings(typeof navigator === 'undefined' ? undefined : navigator.language);
}

export async function loadSettings(): Promise<Settings> {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return sanitizeSettings(data[SETTINGS_KEY], localeDefaults());
  } catch {
    return localeDefaults();
  }
}

/** Throws when storage is unavailable, so callers can tell the user the change wasn't saved. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch }, localeDefaults());
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
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
