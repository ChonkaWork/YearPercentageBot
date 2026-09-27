import {
  addToHistory,
  createHistoryItem,
  removeFromHistory,
  replacePrompt,
  sanitizeHistory,
  type HistoryItem,
  type NewHistoryEntry,
} from '../core/history';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../core/settings';
import { isPromptAction, type PageContext, type PromptAction } from '../core/types';

/**
 * All persistence lives in chrome.storage (local for settings and history, session for
 * short-lived hand-offs). Nothing is synced or sent anywhere.
 */

const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history';
const LAST_INSTRUCTION_KEY = 'lastCustomInstruction';
const PENDING_KEY = 'pendingSelection';
const PENDING_MAX_AGE_MS = 5 * 60 * 1000;

export async function loadSettings(): Promise<Settings> {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return sanitizeSettings(data[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Throws when storage is unavailable, so callers can tell the user the change wasn't saved. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  if (patch.maxHistoryItems !== undefined) {
    await serialized(async () => {
      const history = await loadHistory();
      if (history.length > next.maxHistoryItems) await writeHistory(history.slice(0, next.maxHistoryItems));
    });
  }
  return next;
}

/** Throws when storage is unavailable. */
export async function loadHistory(): Promise<HistoryItem[]> {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return sanitizeHistory(data[HISTORY_KEY]);
}

// History updates are read-modify-write; serialize them within a context so two quick
// context-menu actions can't overwrite each other.
let historyQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = historyQueue.then(task, task);
  historyQueue = run.catch(() => undefined);
  return run;
}

/**
 * Saves a prompt to history. When storage is full, older items are dropped rather than
 * failing. Returns null when history is disabled.
 */
export function addHistoryItem(entry: NewHistoryEntry, max: number): Promise<HistoryItem | null> {
  return serialized(() => addHistoryItemNow(entry, max));
}

async function addHistoryItemNow(entry: NewHistoryEntry, max: number): Promise<HistoryItem | null> {
  if (max <= 0) return null;
  const item = createHistoryItem(entry, crypto.randomUUID(), Date.now());
  let items = addToHistory(await loadHistory(), item, max);
  for (;;) {
    try {
      await writeHistory(items);
      return item;
    } catch (error) {
      if (!isQuotaError(error) || items.length <= 1) throw error;
      items = items.slice(0, Math.ceil(items.length / 2));
    }
  }
}

export function deleteHistoryItem(id: string): Promise<HistoryItem[]> {
  return serialized(async () => {
    const items = removeFromHistory(await loadHistory(), id);
    await writeHistory(items);
    return items;
  });
}

export function updateHistoryPrompt(id: string, prompt: string): Promise<void> {
  return serialized(async () => writeHistory(replacePrompt(await loadHistory(), id, prompt)));
}

export function clearHistory(): Promise<void> {
  return serialized(() => chrome.storage.local.remove(HISTORY_KEY));
}

export async function loadLastInstruction(): Promise<string> {
  try {
    const data = await chrome.storage.local.get(LAST_INSTRUCTION_KEY);
    const value = data[LAST_INSTRUCTION_KEY];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export async function saveLastInstruction(instruction: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [LAST_INSTRUCTION_KEY]: instruction });
  } catch {
    // Convenience only.
  }
}

// --- Hand-off to the popup when a page can't show the in-page panel ---------------------

export interface PendingSelection {
  text: string;
  page: PageContext | null;
  action?: PromptAction;
  message?: string;
  createdAt: number;
}

export async function setPendingSelection(pending: Omit<PendingSelection, 'createdAt'>): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: { ...pending, createdAt: Date.now() } });
}

/** Reads and clears the pending selection. Stale entries are ignored. */
export async function takePendingSelection(): Promise<PendingSelection | null> {
  try {
    const data = await chrome.storage.session.get(PENDING_KEY);
    await chrome.storage.session.remove(PENDING_KEY);
    const value = data[PENDING_KEY] as Partial<PendingSelection> | undefined;
    if (!value || typeof value.text !== 'string' || typeof value.createdAt !== 'number') return null;
    if (Date.now() - value.createdAt > PENDING_MAX_AGE_MS) return null;
    const pending: PendingSelection = { text: value.text, page: value.page ?? null, createdAt: value.createdAt };
    if (isPromptAction(value.action)) pending.action = value.action;
    if (typeof value.message === 'string') pending.message = value.message;
    return pending;
  } catch {
    return null;
  }
}

async function writeHistory(items: HistoryItem[]): Promise<void> {
  await chrome.storage.local.set({ [HISTORY_KEY]: items });
}

function isQuotaError(error: unknown): boolean {
  return error instanceof Error && /quota/i.test(error.message);
}
