import { sanitizeHistory, type ValuePoint } from '../core/history';
import { sanitizeNoise, type NoiseState } from '../core/noise';
import { EARLY_ACCESS, sanitizePlan, setEarlyAccessForTesting, type Plan } from '../core/plan';
import { sanitizeHeld, type HeldNotification } from '../core/quiet';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../core/settings';
import type { Change, Snapshot, Watch } from '../core/types';
import { sanitizeChanges, sanitizeSnapshot, sanitizeWatches } from '../core/watch';
import { isPendingAdd, type PendingAdd } from '../platform/messages';

/**
 * Everything is kept in chrome.storage.local, in this browser only:
 *   watches            Watch[] (small: settings and status of every watch)
 *   snapshot:<id>      latest text of a watch (the baseline for the next comparison)
 *   changes:<id>       last 10 changes of a watch, with their diffs
 *   noise:<id>         noise filter of a watch: learned rules and where learning stands
 *   history:<id>       values of a number or price watch, one per check (up to 500 points)
 *   settings           Settings
 *   plan               'free' | 'pro' (set by a future payments adapter; default 'free')
 *   heldNotifications  notifications held during quiet hours, delivered as one summary after
 * Short-lived state goes to chrome.storage.session. Everything is sanitized on read.
 */

export const WATCHES_KEY = 'watches';
export const SETTINGS_KEY = 'settings';
export const PENDING_ADD_KEY = 'pendingAdd';
export const CHECKING_KEY = 'checking';
export const PLAN_KEY = 'plan';
export const HELD_KEY = 'heldNotifications';
/** e2e builds only: set to false to try the free plan while early access is on. */
export const E2E_EARLY_ACCESS_KEY = 'e2e:earlyAccess';
const PENDING_MAX_AGE_MS = 5 * 60_000;

export const snapshotKey = (id: string) => `snapshot:${id}`;
export const changesKey = (id: string) => `changes:${id}`;
export const noiseKey = (id: string) => `noise:${id}`;
export const historyKey = (id: string) => `history:${id}`;

export async function loadWatches(): Promise<Watch[]> {
  const data = await chrome.storage.local.get(WATCHES_KEY);
  return sanitizeWatches(data[WATCHES_KEY]);
}

export async function loadWatch(id: string): Promise<Watch | null> {
  return (await loadWatches()).find((watch) => watch.id === id) ?? null;
}

export async function loadChanges(id: string): Promise<Change[]> {
  const key = changesKey(id);
  const data = await chrome.storage.local.get(key);
  return sanitizeChanges(data[key]);
}

export async function loadSnapshot(id: string): Promise<Snapshot | null> {
  const key = snapshotKey(id);
  const data = await chrome.storage.local.get(key);
  return sanitizeSnapshot(data[key]);
}

export async function loadNoise(id: string): Promise<NoiseState> {
  const key = noiseKey(id);
  const data = await chrome.storage.local.get(key);
  return sanitizeNoise(data[key]);
}

export async function loadHistory(id: string): Promise<ValuePoint[]> {
  const key = historyKey(id);
  const data = await chrome.storage.local.get(key);
  return sanitizeHistory(data[key]);
}

/** Histories of several watches in one read (the popup's rows). */
export async function loadHistories(ids: readonly string[]): Promise<Map<string, ValuePoint[]>> {
  const out = new Map<string, ValuePoint[]>();
  if (ids.length === 0) return out;
  const data = await chrome.storage.local.get(ids.map(historyKey));
  for (const id of ids) {
    const points = sanitizeHistory(data[historyKey(id)]);
    if (points.length > 0) out.set(id, points);
  }
  return out;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return sanitizeSettings(data[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** The stored plan (sanitized, 'free' by default). Pro checks go through core/plan with it. */
export async function loadPlan(): Promise<Plan> {
  try {
    const data = await chrome.storage.local.get(__E2E__ ? [PLAN_KEY, E2E_EARLY_ACCESS_KEY] : PLAN_KEY);
    if (__E2E__) {
      const early = data[E2E_EARLY_ACCESS_KEY];
      setEarlyAccessForTesting(typeof early === 'boolean' ? early : EARLY_ACCESS);
    }
    return sanitizePlan(data[PLAN_KEY]);
  } catch {
    return 'free';
  }
}

/** Storage keys whose change means the plan (or, in e2e builds, early access) changed. */
export function planChanged(changes: Record<string, unknown>): boolean {
  return PLAN_KEY in changes || (__E2E__ && E2E_EARLY_ACCESS_KEY in changes);
}

export async function loadHeld(): Promise<HeldNotification[]> {
  const data = await chrome.storage.local.get(HELD_KEY);
  return sanitizeHeld(data[HELD_KEY]);
}

export async function saveHeld(held: HeldNotification[]): Promise<void> {
  if (held.length === 0) await chrome.storage.local.remove(HELD_KEY);
  else await chrome.storage.local.set({ [HELD_KEY]: held });
}

/** Throws when storage is unavailable, so the options page can say the change wasn't saved. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// --- Writes (service worker only) --------------------------------------------------------

// Every write is read-modify-write. The service worker is the only writer and runs them one
// at a time, so a check finishing while the user pauses a watch can't lose either update.
let queue: Promise<unknown> = Promise.resolve();

export function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

export async function writeWatches(watches: Watch[], extra: Record<string, unknown> = {}): Promise<void> {
  await chrome.storage.local.set({ [WATCHES_KEY]: watches, ...extra });
}

/** Loads, transforms and saves one watch. Returns null when it doesn't exist (anymore). */
export function updateWatch(id: string, update: (watch: Watch) => Watch): Promise<Watch | null> {
  return serialized(async () => {
    const watches = await loadWatches();
    const index = watches.findIndex((watch) => watch.id === id);
    if (index < 0) return null;
    const next = update(watches[index]!);
    watches[index] = next;
    await writeWatches(watches);
    return next;
  });
}

export async function removeWatchData(id: string): Promise<void> {
  await chrome.storage.local.remove([snapshotKey(id), changesKey(id), noiseKey(id), historyKey(id)]);
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof Error && /quota/i.test(error.message);
}

// --- Session state -------------------------------------------------------------------

export async function setPendingAdd(pending: PendingAdd): Promise<void> {
  await chrome.storage.session.set({ [PENDING_ADD_KEY]: pending });
}

export async function loadPendingAdd(): Promise<PendingAdd | null> {
  try {
    const data = await chrome.storage.session.get(PENDING_ADD_KEY);
    const pending = data[PENDING_ADD_KEY];
    if (!isPendingAdd(pending) || Date.now() - pending.createdAt > PENDING_MAX_AGE_MS) return null;
    return pending;
  } catch {
    return null;
  }
}

export async function clearPendingAdd(id?: string): Promise<void> {
  try {
    if (id !== undefined) {
      const current = await loadPendingAdd();
      if (current && current.id !== id) return;
    }
    await chrome.storage.session.remove(PENDING_ADD_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Watch ids with a check in progress, and when it started (the popup shows a spinner). */
export type CheckingState = Record<string, number>;

export function sanitizeChecking(value: unknown, now = Date.now()): CheckingState {
  if (typeof value !== 'object' || value === null) return {};
  const state: CheckingState = {};
  for (const [id, startedAt] of Object.entries(value as Record<string, unknown>)) {
    // A check never takes this long; an entry this old was left by a stopped worker.
    if (typeof startedAt === 'number' && now - startedAt < 90_000) state[id] = startedAt;
  }
  return state;
}

export async function loadChecking(): Promise<CheckingState> {
  try {
    const data = await chrome.storage.session.get(CHECKING_KEY);
    return sanitizeChecking(data[CHECKING_KEY]);
  } catch {
    return {};
  }
}

export async function saveChecking(state: CheckingState): Promise<void> {
  try {
    await chrome.storage.session.set({ [CHECKING_KEY]: state });
  } catch {
    // Only drives a spinner.
  }
}
