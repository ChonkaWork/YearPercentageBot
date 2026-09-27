import { isDataError } from './errors';

/**
 * TTL cache for API results. Fresh entries (younger than the TTL) are served without a
 * request. When a refresh fails, an older entry is served marked `stale` together with the
 * error, so the UI can say "showing data from 6 min ago" instead of going blank. Only
 * NOT_FOUND / UNSUPPORTED results are never served stale: the market is gone.
 */

export interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

export interface CacheBackend {
  get(key: string): Promise<CacheEntry<unknown> | null>;
  set(key: string, entry: CacheEntry<unknown>): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Fetched<T> {
  data: T;
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
  /** The error of the failed refresh when `stale`. */
  error?: unknown;
}

export class MemoryBackend implements CacheBackend {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  async get(key: string): Promise<CacheEntry<unknown> | null> {
    return this.entries.get(key) ?? null;
  }

  async set(key: string, entry: CacheEntry<unknown>): Promise<void> {
    this.entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export interface CacheOptions {
  ttlMs: number;
  /** Oldest entry that may still be served when a refresh fails. */
  maxStaleMs: number;
  now?: () => number;
}

export class TtlCache {
  private readonly inflight = new Map<string, Promise<Fetched<unknown>>>();
  private readonly now: () => number;

  constructor(
    private readonly backend: CacheBackend,
    private readonly options: CacheOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async get<T>(key: string, load: () => Promise<T>, options: { force?: boolean } = {}): Promise<Fetched<T>> {
    const entry = await this.read<T>(key);
    const now = this.now();
    if (!options.force && entry && now - entry.storedAt < this.options.ttlMs && now >= entry.storedAt) {
      return { data: entry.value, fetchedAt: entry.storedAt, fromCache: true, stale: false };
    }

    // Two views asking for the same thing at once share one request.
    const pending = this.inflight.get(key) as Promise<Fetched<T>> | undefined;
    if (pending) return pending;

    const request = (async (): Promise<Fetched<T>> => {
      try {
        const value = await load();
        const storedAt = this.now();
        await this.backend.set(key, { value, storedAt }).catch(() => undefined);
        return { data: value, fetchedAt: storedAt, fromCache: false, stale: false };
      } catch (error) {
        const gone = isDataError(error) && (error.code === 'NOT_FOUND' || error.code === 'UNSUPPORTED_MARKET');
        if (entry && !gone && this.now() - entry.storedAt <= this.options.maxStaleMs && !isAbort(error)) {
          return { data: entry.value, fetchedAt: entry.storedAt, fromCache: true, stale: true, error };
        }
        if (gone) await this.backend.delete(key).catch(() => undefined);
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, request);
    return request;
  }

  private async read<T>(key: string): Promise<CacheEntry<T> | null> {
    try {
      const entry = await this.backend.get(key);
      if (!entry || typeof entry.storedAt !== 'number' || !Number.isFinite(entry.storedAt) || entry.value === undefined) return null;
      return entry as CacheEntry<T>;
    } catch {
      return null;
    }
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
