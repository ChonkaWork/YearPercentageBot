import { addToBasket, removeFromBasket, sanitizeBasket, type AddResult, type BasketItem } from '../core/basket';
import { limitsFor, sanitizePlan, type Plan } from '../core/plan';
import { sanitizeRecording, type StoredRecording } from '../core/recording';
import { defaultSettings, sanitizeSettings, type Settings } from '../core/settings';
import type { ToastMessage } from '../page/toast';

/**
 * Everything lives in chrome.storage.local (this browser only, never synced): settings,
 * the plan, the basket and the last row recording. The last notice from the background
 * (when it couldn't show a toast in the page) lives in chrome.storage.session until the
 * popup shows it.
 */

const SETTINGS_KEY = 'settings';
const PLAN_KEY = 'plan';
const BASKET_KEY = 'basket';
const RECORDING_KEY = 'recording';
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

export async function loadPlan(): Promise<Plan> {
  try {
    const data = await chrome.storage.local.get(PLAN_KEY);
    return sanitizePlan(data[PLAN_KEY]);
  } catch {
    return 'free';
  }
}

// --- Basket -----------------------------------------------------------------------------

export async function loadBasket(): Promise<BasketItem[]> {
  try {
    const data = await chrome.storage.local.get(BASKET_KEY);
    return sanitizeBasket(data[BASKET_KEY]);
  } catch {
    return [];
  }
}

async function saveBasket(items: BasketItem[]): Promise<void> {
  await chrome.storage.local.set({ [BASKET_KEY]: items });
}

/** Adds a table within the plan's limits. Throws when storage fails. */
export async function addBasketItem(item: BasketItem): Promise<AddResult> {
  const [items, plan] = await Promise.all([loadBasket(), loadPlan()]);
  const result = addToBasket(items, item, limitsFor(plan));
  if (result.ok) await saveBasket(result.items);
  return result;
}

export async function removeBasketItem(id: string): Promise<BasketItem[]> {
  const next = removeFromBasket(await loadBasket(), id);
  await saveBasket(next);
  return next;
}

export async function clearBasket(): Promise<void> {
  await chrome.storage.local.remove(BASKET_KEY);
}

export function newItemId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// --- Row recording ----------------------------------------------------------------------

/** The last recording (one at a time), written by the recorder in the page as it goes. */
export async function loadRecording(): Promise<StoredRecording | null> {
  try {
    const data = await chrome.storage.local.get(RECORDING_KEY);
    return sanitizeRecording(data[RECORDING_KEY]);
  } catch {
    return null;
  }
}

export async function saveRecording(recording: StoredRecording): Promise<void> {
  await chrome.storage.local.set({ [RECORDING_KEY]: recording });
}

export async function clearRecording(): Promise<void> {
  await chrome.storage.local.remove(RECORDING_KEY);
}

export function isRecordingChange(changes: Record<string, chrome.storage.StorageChange>): boolean {
  return RECORDING_KEY in changes;
}

// --- Notices ----------------------------------------------------------------------------

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
