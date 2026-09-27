import { isValidSymbol } from '../core/assets';
import { addToHistory, removeFromHistory, sanitizeHistory, type HistoryEntry } from '../core/history';
import { asObject } from '../core/sanitize';
import {
  DEFAULT_SETTINGS,
  DEFAULT_UI_STATE,
  sanitizeSettings,
  sanitizeUiState,
  sanitizeUsage,
  type Settings,
  type UiState,
  type Usage,
} from '../core/settings';
import type { KeyValueStore } from '../data/market';

/**
 * All persistence is chrome.storage: local for settings, history and usage; session for the
 * market-data cache and short-lived hand-offs. Nothing is synced or sent anywhere.
 * Every read is sanitized, so a corrupted or outdated value falls back to defaults.
 */

const SETTINGS_KEY = 'settings';
const UI_KEY = 'ui';
const HISTORY_KEY = 'history';
const USAGE_KEY = 'usage';
const PENDING_KEY = 'pendingAnalysis';
const PENDING_MAX_AGE_MS = 5 * 60 * 1000;

/** chrome.storage.session as a key-value store for the market cache. */
export const sessionStore: KeyValueStore = {
  async get(key) {
    const data = await chrome.storage.session.get(key);
    return data[key];
  },
  async set(key, value) {
    await chrome.storage.session.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.session.remove(key);
  },
};

// --- Settings and UI state --------------------------------------------------------------

export async function loadSettings(): Promise<Settings> {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return sanitizeSettings(data[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Throws when storage is unavailable, so the caller can say the change wasn't saved. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  if (patch.historyLimit !== undefined) {
    await serialized(async () => {
      const history = await loadHistory();
      if (history.length > next.historyLimit) await writeHistory(history.slice(0, next.historyLimit));
    });
  }
  return next;
}

export async function loadUiState(): Promise<UiState> {
  try {
    const data = await chrome.storage.local.get(UI_KEY);
    return sanitizeUiState(data[UI_KEY]);
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
}

export async function saveUiState(patch: Partial<UiState>): Promise<void> {
  try {
    const next = sanitizeUiState({ ...(await loadUiState()), ...patch });
    await chrome.storage.local.set({ [UI_KEY]: next });
  } catch {
    // Convenience only.
  }
}

// --- History ----------------------------------------------------------------------------

/** Throws when storage is unavailable. */
export async function loadHistory(): Promise<HistoryEntry[]> {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return sanitizeHistory(data[HISTORY_KEY]);
}

// Read-modify-write: serialize within a context so quick successive saves can't overwrite each other.
let historyQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = historyQueue.then(task, task);
  historyQueue = run.catch(() => undefined);
  return run;
}

/** Saves an analysis. When storage is full, older entries are dropped instead of failing. */
export function addHistoryEntry(entry: HistoryEntry, max: number): Promise<boolean> {
  return serialized(async () => {
    if (max <= 0) return false;
    let items = addToHistory(await loadHistory(), entry, max);
    for (;;) {
      try {
        await writeHistory(items);
        return true;
      } catch (error) {
        if (!isQuotaError(error) || items.length <= 1) throw error;
        items = items.slice(0, Math.ceil(items.length / 2));
      }
    }
  });
}

export function deleteHistoryEntry(id: string): Promise<HistoryEntry[]> {
  return serialized(async () => {
    const items = removeFromHistory(await loadHistory(), id);
    await writeHistory(items);
    return items;
  });
}

export function clearHistory(): Promise<void> {
  return serialized(() => chrome.storage.local.remove(HISTORY_KEY));
}

async function writeHistory(items: HistoryEntry[]): Promise<void> {
  await chrome.storage.local.set({ [HISTORY_KEY]: items });
}

function isQuotaError(error: unknown): boolean {
  return error instanceof Error && /quota/i.test(error.message);
}

// --- Daily usage (Free plan preview) ----------------------------------------------------

export async function loadUsage(now: number = Date.now()): Promise<Usage> {
  try {
    const data = await chrome.storage.local.get(USAGE_KEY);
    return sanitizeUsage(data[USAGE_KEY], now);
  } catch {
    return sanitizeUsage(null, now);
  }
}

export async function recordAnalysis(now: number = Date.now()): Promise<Usage> {
  const usage = await loadUsage(now);
  const next = { day: usage.day, count: usage.count + 1 };
  try {
    await chrome.storage.local.set({ [USAGE_KEY]: next });
  } catch {
    // Counting is best effort.
  }
  return next;
}

// --- Hand-off from the context menu to the popup ----------------------------------------

export interface PendingAnalysis {
  /** Detected symbol, or null when the selection didn't look like a coin. */
  symbol: string | null;
  /** The selected text (trimmed), for the "couldn't find a coin" message. */
  selection: string;
  createdAt: number;
}

export async function setPendingAnalysis(pending: Omit<PendingAnalysis, 'createdAt'>): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: { ...pending, createdAt: Date.now() } });
}

/** Reads and clears the pending request. Old or malformed entries are ignored. */
export async function takePendingAnalysis(now: number = Date.now()): Promise<PendingAnalysis | null> {
  try {
    const data = await chrome.storage.session.get(PENDING_KEY);
    await chrome.storage.session.remove(PENDING_KEY);
    return sanitizePending(data[PENDING_KEY], now);
  } catch {
    return null;
  }
}

export function sanitizePending(raw: unknown, now: number): PendingAnalysis | null {
  const value = asObject(raw);
  if (!value || typeof value.createdAt !== 'number' || typeof value.selection !== 'string') return null;
  if (now - value.createdAt > PENDING_MAX_AGE_MS || value.createdAt > now + 60_000) return null;
  const symbol = isValidSymbol(value.symbol) ? value.symbol : null;
  return { symbol, selection: value.selection.slice(0, 200), createdAt: value.createdAt };
}
