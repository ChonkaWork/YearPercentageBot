import { sanitizeTemplates, type CustomTemplate } from '../core/customTemplates';
import {
  addToHistory,
  clearUnpinned,
  createHistoryItem,
  removeFromHistory,
  replacePrompt,
  sanitizeHistory,
  setPinned,
  trimHistory,
  type HistoryItem,
  type NewHistoryEntry,
} from '../core/history';
import { EARLY_ACCESS, historyCap, limitsFor, sanitizePlan, type Limits, type Plan } from '../core/plan';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../core/settings';
import { isPromptAction, type PageContext, type PromptAction } from '../core/types';

/**
 * All persistence lives in chrome.storage (local for settings and history, session for
 * short-lived hand-offs). Nothing is synced or sent anywhere.
 */

const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history';
const LAST_INSTRUCTION_KEY = 'lastCustomInstruction';
const TEMPLATES_KEY = 'customTemplates';
/** Written only by a future payments adapter (see docs/MONETIZATION.md). */
export const PLAN_KEY = 'plan';
/**
 * e2e build only: lets the test switch early access off to check the free plan. Every use is
 * behind `__E2E__`, so the production build doesn't contain it.
 */
const E2E_EARLY_ACCESS_KEY = 'e2eEarlyAccess';
/** Storage keys whose change affects the context menu. */
export const MENU_KEYS: readonly string[] = __E2E__ ? [TEMPLATES_KEY, PLAN_KEY, E2E_EARLY_ACCESS_KEY] : [TEMPLATES_KEY, PLAN_KEY];
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

// Settings saves are read-modify-write too: two quick changes on the options page (e.g. the
// default action and the history size) must not overwrite each other with a stale read.
let settingsQueue: Promise<unknown> = Promise.resolve();

/** Throws when storage is unavailable, so callers can tell the user the change wasn't saved. */
export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = settingsQueue.then(
    () => saveSettingsNow(patch),
    () => saveSettingsNow(patch),
  );
  settingsQueue = run.catch(() => undefined);
  return run;
}

async function saveSettingsNow(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  if (patch.maxHistoryItems !== undefined) {
    // The user lowered the size themselves: drop the oldest unpinned prompts to match.
    await serialized(async () => {
      const history = await loadHistory();
      const trimmed = trimHistory(history, next.maxHistoryItems);
      if (trimmed.length < history.length) await writeHistory(trimmed);
    });
  }
  return next;
}

// --- Plan -------------------------------------------------------------------------------

export interface PlanState {
  plan: Plan;
  earlyAccess: boolean;
  limits: Limits;
}

/** The stored plan (sanitized, default free) and what it allows. */
export async function loadPlanState(): Promise<PlanState> {
  let plan: Plan = 'free';
  let earlyAccess = EARLY_ACCESS;
  try {
    const data = await chrome.storage.local.get(__E2E__ ? [PLAN_KEY, E2E_EARLY_ACCESS_KEY] : [PLAN_KEY]);
    plan = sanitizePlan(data[PLAN_KEY]);
    if (__E2E__ && typeof data[E2E_EARLY_ACCESS_KEY] === 'boolean') earlyAccess = data[E2E_EARLY_ACCESS_KEY];
  } catch {
    // Storage unavailable: free plan (early access still applies).
  }
  return { plan, earlyAccess, limits: limitsFor(plan, earlyAccess) };
}

// --- Custom templates -------------------------------------------------------------------

export async function loadTemplates(): Promise<CustomTemplate[]> {
  try {
    const data = await chrome.storage.local.get(TEMPLATES_KEY);
    return sanitizeTemplates(data[TEMPLATES_KEY]);
  } catch {
    return [];
  }
}

/** Throws when storage is unavailable, so the editor can say the change wasn't saved. */
export async function saveTemplates(templates: readonly CustomTemplate[]): Promise<CustomTemplate[]> {
  const clean = sanitizeTemplates(templates);
  await chrome.storage.local.set({ [TEMPLATES_KEY]: clean });
  return clean;
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
 * Saves a prompt to history. `requested` is the user's history size, `limits` the plan's
 * (defaults to the free plan's, which early access lifts). When storage is full, older
 * unpinned items are dropped rather than failing. Returns null when history is disabled.
 */
export function addHistoryItem(
  entry: NewHistoryEntry,
  requested: number,
  limits: Limits = limitsFor('free'),
): Promise<HistoryItem | null> {
  return serialized(() => addHistoryItemNow(entry, requested, limits));
}

async function addHistoryItemNow(entry: NewHistoryEntry, requested: number, limits: Limits): Promise<HistoryItem | null> {
  if (requested <= 0) return null;
  const item = createHistoryItem(entry, crypto.randomUUID(), Date.now());
  const existing = await loadHistory();
  let items = addToHistory(existing, item, historyCap(requested, limits, existing.length));
  for (;;) {
    try {
      await writeHistory(items);
      return item;
    } catch (error) {
      // Pinned prompts are never dropped to make room; if only they are left, give up.
      const smaller = trimHistory(items, Math.ceil(items.length / 2));
      if (!isQuotaError(error) || smaller.length === items.length || !smaller.includes(item)) throw error;
      items = smaller;
    }
  }
}

export function setHistoryPinned(id: string, pinned: boolean): Promise<void> {
  return serialized(async () => writeHistory(setPinned(await loadHistory(), id, pinned)));
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

/** Removes every prompt except pinned ones. */
export function clearHistory(): Promise<void> {
  return serialized(async () => {
    const pinned = clearUnpinned(await loadHistory());
    if (pinned.length) await writeHistory(pinned);
    else await chrome.storage.local.remove(HISTORY_KEY);
  });
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
  /** A custom template picked from the menu. */
  templateId?: string;
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
    if (typeof value.templateId === 'string') pending.templateId = value.templateId;
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
