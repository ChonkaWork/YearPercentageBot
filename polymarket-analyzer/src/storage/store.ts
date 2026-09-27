import { isPlan, PLAN_LIMITS, type Plan } from '../core/features';
import {
  addSnapshot,
  addToWatchlist,
  removeFromWatchlist,
  sanitizeSnapshots,
  sanitizeWatchlist,
  type AddResult,
  type Snapshot,
  type WatchItem,
} from '../core/saved';
import type { CacheBackend, CacheEntry } from '../data/cache';

/**
 * All persistence is chrome.storage, local to this browser. Nothing is synced or sent anywhere.
 *   local:   plan, watchlist, analysis history
 *   session: API cache (cleared when the browser closes); the context-menu hand-off is in handoff.ts
 * Everything is read back through a sanitizer, so corrupted entries are repaired or dropped.
 */

const PLAN_KEY = 'plan';
const WATCHLIST_KEY = 'watchlist';
const SNAPSHOTS_KEY = 'analysisHistory';
const CACHE_PREFIX = 'cache:';

// Stored lists are capped at the largest plan limit; the effective limit applies when adding.
const STORED_WATCHLIST_MAX = PLAN_LIMITS.pro.watchlist;
const STORED_SNAPSHOTS_MAX = PLAN_LIMITS.pro.history;

export async function loadPlan(): Promise<Plan> {
  try {
    const value = (await chrome.storage.local.get(PLAN_KEY))[PLAN_KEY];
    return isPlan(value) ? value : 'free';
  } catch {
    return 'free';
  }
}

// Read-modify-write updates are serialized so two quick clicks can't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

// --- Watchlist ------------------------------------------------------------------------------

export async function loadWatchlist(): Promise<WatchItem[]> {
  try {
    return sanitizeWatchlist((await chrome.storage.local.get(WATCHLIST_KEY))[WATCHLIST_KEY], STORED_WATCHLIST_MAX);
  } catch {
    return [];
  }
}

export function addWatchItem(item: WatchItem, max: number): Promise<AddResult> {
  return serialized(async () => {
    const result = addToWatchlist(await loadWatchlist(), item, max);
    if (result.ok) await chrome.storage.local.set({ [WATCHLIST_KEY]: result.items });
    return result;
  });
}

export function removeWatchItem(key: string): Promise<WatchItem[]> {
  return serialized(async () => {
    const items = removeFromWatchlist(await loadWatchlist(), key);
    await chrome.storage.local.set({ [WATCHLIST_KEY]: items });
    return items;
  });
}

/** Applies `update` to the item with `key` (if it still exists). */
export function updateWatchItem(key: string, update: (item: WatchItem) => WatchItem): Promise<WatchItem[]> {
  return serialized(async () => {
    const items = (await loadWatchlist()).map((item) => (item.key === key ? update(item) : item));
    await chrome.storage.local.set({ [WATCHLIST_KEY]: items });
    return items;
  });
}

// --- Analysis history -----------------------------------------------------------------------

export async function loadSnapshots(): Promise<Snapshot[]> {
  try {
    return sanitizeSnapshots((await chrome.storage.local.get(SNAPSHOTS_KEY))[SNAPSHOTS_KEY], STORED_SNAPSHOTS_MAX);
  } catch {
    return [];
  }
}

/** Saves an analysis. When storage is full, older entries are dropped instead of failing. */
export function saveSnapshot(snapshot: Snapshot, max: number): Promise<Snapshot[]> {
  return serialized(async () => {
    let items = addSnapshot(await loadSnapshots(), snapshot, max);
    for (;;) {
      try {
        await chrome.storage.local.set({ [SNAPSHOTS_KEY]: items });
        return items;
      } catch (error) {
        if (!/quota/i.test(String(error)) || items.length <= 1) throw error;
        items = items.slice(0, Math.ceil(items.length / 2));
      }
    }
  });
}

export function deleteSnapshot(id: string): Promise<Snapshot[]> {
  return serialized(async () => {
    const items = (await loadSnapshots()).filter((item) => item.id !== id);
    await chrome.storage.local.set({ [SNAPSHOTS_KEY]: items });
    return items;
  });
}

export function clearSnapshots(): Promise<void> {
  return serialized(() => chrome.storage.local.remove(SNAPSHOTS_KEY));
}

// --- API cache in session storage ---------------------------------------------------------

/**
 * Keeps API responses for the browser session, so reopening the popup within the TTL doesn't
 * refetch. Entries older than `maxAgeMs` are pruned now and then.
 */
export class SessionCacheBackend implements CacheBackend {
  constructor(private readonly maxAgeMs: number) {}

  async get(key: string): Promise<CacheEntry<unknown> | null> {
    const value = (await chrome.storage.session.get(CACHE_PREFIX + key))[CACHE_PREFIX + key] as Partial<CacheEntry<unknown>> | undefined;
    if (!value || typeof value.storedAt !== 'number' || !('value' in value)) return null;
    return { value: value.value, storedAt: value.storedAt };
  }

  async set(key: string, entry: CacheEntry<unknown>): Promise<void> {
    try {
      await chrome.storage.session.set({ [CACHE_PREFIX + key]: entry });
    } catch {
      // Quota: drop everything cached and try once more.
      await this.prune(0);
      await chrome.storage.session.set({ [CACHE_PREFIX + key]: entry }).catch(() => undefined);
    }
    if (Math.random() < 0.1) void this.prune(this.maxAgeMs);
  }

  async delete(key: string): Promise<void> {
    await chrome.storage.session.remove(CACHE_PREFIX + key);
  }

  private async prune(maxAgeMs: number): Promise<void> {
    try {
      const all = await chrome.storage.session.get(null);
      const now = Date.now();
      const old = Object.entries(all)
        .filter(([key, value]) => {
          const storedAt = (value as { storedAt?: unknown } | null)?.storedAt;
          return key.startsWith(CACHE_PREFIX) && !(typeof storedAt === 'number' && now - storedAt < maxAgeMs);
        })
        .map(([key]) => key);
      if (old.length) await chrome.storage.session.remove(old);
    } catch {
      // Best effort.
    }
  }
}
