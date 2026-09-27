import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Countdown } from '../src/core/countdown';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings';

type Listener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void;

/** In-memory chrome.storage.local with async, interleaving reads and writes like the real one. */
function installFakeChrome() {
  const data: Record<string, unknown> = {};
  const listeners = new Set<Listener>();
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
  const local = {
    get: vi.fn(async (keys: string | string[]) => {
      await tick();
      const result: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) if (key in data) result[key] = structuredClone(data[key]);
      return result;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await tick();
      Object.assign(data, structuredClone(items));
    }),
  };
  const onChanged = { addListener: (l: Listener) => listeners.add(l), removeListener: (l: Listener) => listeners.delete(l) };
  vi.stubGlobal('chrome', { storage: { local, onChanged } });
  const cache = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => void cache.set(key, value),
  });
  const emit = (changes: Record<string, { newValue?: unknown }>, area = 'local') => {
    for (const listener of listeners) listener(changes, area);
  };
  return { data, local, cache, emit, listeners };
}

function countdown(id: string): Countdown {
  return { id, name: `Countdown ${id}`, date: '2026-12-24', time: null, createdAt: 1, showProgress: true };
}

describe('store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads settings and countdowns in one read and sanitizes both', async () => {
    const fake = installFakeChrome();
    fake.data.settings = { theme: 'neon', weekStart: 'sunday' };
    fake.data.countdowns = [countdown('a'), { id: 'broken' }];
    const { loadState } = await import('../src/storage/store');
    const state = await loadState(5);
    expect(fake.local.get).toHaveBeenCalledTimes(1);
    expect(state.settings).toEqual({ ...sanitizeSettings({}), weekStart: 'sunday' });
    expect(state.countdowns.map((c) => c.id)).toEqual(['a']);
  });

  it('propagates read errors so the page can show them', async () => {
    const fake = installFakeChrome();
    fake.local.get.mockRejectedValueOnce(new Error('broken'));
    const { loadState } = await import('../src/storage/store');
    await expect(loadState()).rejects.toThrow('broken');
  });

  it('saves sanitized settings and mirrors them for the next paint', async () => {
    const fake = installFakeChrome();
    const store = await import('../src/storage/store');
    const saved = await store.saveSettings({ ...sanitizeSettings({}), decimals: '3' as never });
    expect(saved.decimals).toBe(3);
    expect(fake.data.settings).toEqual(saved);
    expect(store.readCachedSettings()).toEqual(saved);
  });

  it('keeps every countdown when changes run concurrently', async () => {
    const fake = installFakeChrome();
    const { updateCountdowns } = await import('../src/storage/store');
    await Promise.all(Array.from({ length: 8 }, (_, i) => updateCountdowns((list) => [...list, countdown(`c${i}`)])));
    expect((fake.data.countdowns as Countdown[]).map((c) => c.id).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `c${i}`).sort());
  });

  it('rejects on write errors and keeps working afterwards', async () => {
    const fake = installFakeChrome();
    const { updateCountdowns } = await import('../src/storage/store');
    fake.local.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await expect(updateCountdowns((list) => [...list, countdown('lost')])).rejects.toThrow('QUOTA_BYTES');
    await expect(updateCountdowns(() => {
      throw new Error('it no longer exists');
    })).rejects.toThrow('it no longer exists');
    const list = await updateCountdowns((current) => [...current, countdown('kept')]);
    expect(list.map((c) => c.id)).toEqual(['kept']);
    expect(fake.data.countdowns).toEqual(list);
  });

  it('reports changes from other tabs, sanitized, and can stop', async () => {
    const fake = installFakeChrome();
    const { watchStorage } = await import('../src/storage/store');
    const seen: unknown[] = [];
    const stop = watchStorage((change) => seen.push(change));
    fake.emit({ settings: { newValue: { accent: 'blue', theme: 42 } } });
    fake.emit({ countdowns: { newValue: [countdown('x'), 'junk'] } });
    fake.emit({ settings: { newValue: {} } }, 'sync');
    fake.emit({ unrelated: { newValue: 1 } });
    fake.emit({ settings: {} });
    expect(seen).toEqual([
      { settings: { ...sanitizeSettings({}), accent: 'blue' } },
      { countdowns: [countdown('x')] },
      { settings: DEFAULT_SETTINGS },
    ]);
    stop();
    expect(fake.listeners.size).toBe(0);
  });

  it('treats the paint-time cache as optional', async () => {
    const fake = installFakeChrome();
    const store = await import('../src/storage/store');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(store.readCachedSettings()).toBeNull();
    fake.cache.set(store.SETTINGS_CACHE_KEY, '{not json');
    expect(store.readCachedSettings()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    fake.cache.set(store.SETTINGS_CACHE_KEY, JSON.stringify({ theme: 'dark', accent: 'nope' }));
    expect(store.readCachedSettings()).toEqual({ ...sanitizeSettings({}), theme: 'dark' });
    expect(store.readCachedSettings(null)).toBeNull();
    const throwing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => store.writeCachedSettings(DEFAULT_SETTINGS, throwing)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
