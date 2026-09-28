import { sanitizeCountdowns, type Countdown } from '../core/countdown';
import { sanitizeGoals, type Goal } from '../core/goals';
import { sanitizeLinks, type QuickLink } from '../core/links';
import { sanitizePlan, type Plan } from '../core/plan';
import { sanitizeSettings, type Settings } from '../core/settings';

/**
 * Persistence. chrome.storage.local is the source of truth for settings, countdowns, goals and
 * quick links; nothing
 * is synced or sent anywhere. Settings are also mirrored into localStorage, which is synchronous,
 * so the page can apply the theme and hide rows before its first paint instead of flashing the
 * defaults on every new tab.
 */

const SETTINGS_KEY = 'settings';
const COUNTDOWNS_KEY = 'countdowns';
const GOALS_KEY = 'goals';
const LINKS_KEY = 'links';
/** 'free' | 'pro'. Only a future payments adapter writes it; the page just reads it. */
const PLAN_KEY = 'plan';
export const SETTINGS_CACHE_KEY = 'progress-tab:settings';
export const PLAN_CACHE_KEY = 'progress-tab:plan';

export interface StoredState {
  settings: Settings;
  countdowns: Countdown[];
  goals: Goal[];
  links: QuickLink[];
  plan: Plan;
}

/** One read for everything the page needs. Throws when storage is unavailable. */
export async function loadState(now = Date.now()): Promise<StoredState> {
  const data = await chrome.storage.local.get([SETTINGS_KEY, COUNTDOWNS_KEY, GOALS_KEY, LINKS_KEY, PLAN_KEY]);
  return {
    settings: sanitizeSettings(data[SETTINGS_KEY]),
    countdowns: sanitizeCountdowns(data[COUNTDOWNS_KEY], now),
    goals: sanitizeGoals(data[GOALS_KEY], now),
    links: sanitizeLinks(data[LINKS_KEY]),
    plan: sanitizePlan(data[PLAN_KEY]),
  };
}

/** Throws when storage is unavailable, so the caller can tell the user it wasn't saved. */
export async function saveSettings(settings: Settings): Promise<Settings> {
  const clean = sanitizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean });
  writeCachedSettings(clean);
  return clean;
}

// List changes (countdowns, goals, links) are read-modify-write; serialize them within the page
// so two quick edits (or +1 clicks) can't overwrite each other. Each one re-reads storage, so
// edits made in another tab are kept.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function updateList<T>(key: string, sanitize: (raw: unknown) => T[], change: (list: T[]) => T[]): Promise<T[]> {
  return serialized(async () => {
    const data = await chrome.storage.local.get(key);
    const next = sanitize(change(sanitize(data[key])));
    await chrome.storage.local.set({ [key]: next });
    return next;
  });
}

/** Applies `change` to the stored list and saves it. Throws on storage errors (and whatever `change` throws). */
export function updateCountdowns(change: (list: Countdown[]) => Countdown[], now = Date.now()): Promise<Countdown[]> {
  return updateList(COUNTDOWNS_KEY, (raw) => sanitizeCountdowns(raw, now), change);
}

export function updateGoals(change: (list: Goal[]) => Goal[], now = Date.now()): Promise<Goal[]> {
  return updateList(GOALS_KEY, (raw) => sanitizeGoals(raw, now), change);
}

export function updateLinks(change: (list: QuickLink[]) => QuickLink[]): Promise<QuickLink[]> {
  return updateList(LINKS_KEY, sanitizeLinks, change);
}

export interface StorageChange {
  settings?: Settings;
  countdowns?: Countdown[];
  goals?: Goal[];
  links?: QuickLink[];
  plan?: Plan;
}

/** Changes made by any page of the extension (other open new tabs included). */
export function watchStorage(listener: (change: StorageChange) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    const change: StorageChange = {};
    if (SETTINGS_KEY in changes) change.settings = sanitizeSettings(changes[SETTINGS_KEY]?.newValue);
    if (COUNTDOWNS_KEY in changes) change.countdowns = sanitizeCountdowns(changes[COUNTDOWNS_KEY]?.newValue, Date.now());
    if (GOALS_KEY in changes) change.goals = sanitizeGoals(changes[GOALS_KEY]?.newValue, Date.now());
    if (LINKS_KEY in changes) change.links = sanitizeLinks(changes[LINKS_KEY]?.newValue);
    if (PLAN_KEY in changes) change.plan = sanitizePlan(changes[PLAN_KEY]?.newValue);
    if (Object.keys(change).length > 0) listener(change);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

// --- Paint-time cache --------------------------------------------------------------------------
// Only a speed-up: if it's missing or broken the page starts from the defaults and corrects itself
// once chrome.storage answers, so failures here are logged rather than shown.

type CacheStorage = Pick<Storage, 'getItem' | 'setItem'>;

function localStorageOrNull(): CacheStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readCachedSettings(storage: CacheStorage | null = localStorageOrNull()): Settings | null {
  try {
    const raw = storage?.getItem(SETTINGS_CACHE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : null;
  } catch (error) {
    console.warn('Progress Tab: ignoring the cached settings', error);
    return null;
  }
}

export function writeCachedSettings(settings: Settings, storage: CacheStorage | null = localStorageOrNull()): void {
  try {
    storage?.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('Progress Tab: could not cache the settings', error);
  }
}

/** The plan, mirrored like the settings so a Pro theme applies before the first paint. */
export function readCachedPlan(storage: CacheStorage | null = localStorageOrNull()): Plan {
  try {
    return sanitizePlan(storage?.getItem(PLAN_CACHE_KEY));
  } catch {
    return 'free';
  }
}

export function writeCachedPlan(plan: Plan, storage: CacheStorage | null = localStorageOrNull()): void {
  try {
    storage?.setItem(PLAN_CACHE_KEY, plan);
  } catch (error) {
    console.warn('Progress Tab: could not cache the plan', error);
  }
}
