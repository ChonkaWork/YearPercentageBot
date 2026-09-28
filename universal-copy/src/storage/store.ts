import { isClipFormat, isTableFormat, type ClipFormat, type TableFormat } from '../core/convert';
import { EARLY_ACCESS, hasFeature, sanitizePlan, type Plan, type ProFeature } from '../core/plan';
import { defaultSettings, sanitizeSettings, type Settings } from '../core/settings';
import type { ToastMessage } from '../page/toast';

/**
 * Settings live in chrome.storage.local (this browser only, never synced). The last
 * notice from the background (when it couldn't show a toast in the page) lives in
 * chrome.storage.session until the popup shows it.
 */

const SETTINGS_KEY = 'settings';
const NOTICE_KEY = 'notice';
const PLAN_KEY = 'plan';
const POPUP_KEY = 'popup';
/** e2e build only: lets tests see what a free user sees once early access ends. */
const E2E_EARLY_ACCESS_KEY = 'e2eEarlyAccess';
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

// --- Popup ---------------------------------------------------------------------------------

/** What the popup remembers between openings: the last formats used. */
export interface PopupState {
  format: ClipFormat;
  tableFormat: TableFormat;
}

const DEFAULT_POPUP_STATE: PopupState = { format: 'markdown', tableFormat: 'csv' };

export async function loadPopupState(): Promise<PopupState> {
  try {
    const data = await chrome.storage.local.get(POPUP_KEY);
    const raw = (data[POPUP_KEY] ?? {}) as Partial<Record<keyof PopupState, unknown>>;
    return {
      format: isClipFormat(raw.format) ? raw.format : DEFAULT_POPUP_STATE.format,
      tableFormat: isTableFormat(raw.tableFormat) ? raw.tableFormat : DEFAULT_POPUP_STATE.tableFormat,
    };
  } catch {
    return { ...DEFAULT_POPUP_STATE };
  }
}

/** Best effort: a format that isn't remembered is not worth an error message. */
export async function savePopupState(patch: Partial<PopupState>): Promise<void> {
  try {
    await chrome.storage.local.set({ [POPUP_KEY]: { ...(await loadPopupState()), ...patch } });
  } catch {
    // Ignore.
  }
}

// --- Plan ---------------------------------------------------------------------------------

export interface Entitlements {
  plan: Plan;
  earlyAccess: boolean;
}

/** The stored plan (set by a future payments adapter), sanitized; 'free' when unreadable. */
export async function loadEntitlements(): Promise<Entitlements> {
  try {
    const data = await chrome.storage.local.get(__E2E__ ? [PLAN_KEY, E2E_EARLY_ACCESS_KEY] : PLAN_KEY);
    const earlyAccess = __E2E__ && data[E2E_EARLY_ACCESS_KEY] === false ? false : EARLY_ACCESS;
    return { plan: sanitizePlan(data[PLAN_KEY]), earlyAccess };
  } catch {
    return { plan: 'free', earlyAccess: EARLY_ACCESS };
  }
}

export function canUse(entitlements: Entitlements, feature: ProFeature): boolean {
  return hasFeature(entitlements.plan, feature, entitlements.earlyAccess);
}
