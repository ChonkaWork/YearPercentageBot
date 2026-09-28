import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketSummary, Snapshot, WatchItem } from '../src/core/saved';

/** In-memory chrome.storage with async, interleaving reads and writes like the real one. */
function installFakeChrome() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
  const area = (data: Record<string, unknown>) => ({
    async get(key: string | null) {
      await tick();
      if (key === null) return structuredClone(data);
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items: Record<string, unknown>) {
      await tick();
      Object.assign(data, structuredClone(items));
    },
    async remove(keys: string | string[]) {
      await tick();
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  });
  const chrome = { storage: { local: area(local), session: area(session) } };
  vi.stubGlobal('chrome', chrome);
  return { local, session, chrome };
}

const summary: MarketSummary = { probability: 0.5, change24h: 0, change7d: 0, volume24h: 1, liquidity: 1, signal: 'NEUTRAL', strength: 0, at: 1 };
const item = (index: number): WatchItem => ({
  key: `event-${index}/`,
  ref: { eventSlug: `event-${index}`, marketSlug: null },
  title: `Market ${index}`,
  outcome: 'Yes',
  addedAt: index + 1,
  last: summary,
  previous: null,
  alerts: [],
  alertSettings: { enabled: false, movePp: 5, volumePct: 100, momentumFlip: true },
});
const snapshot = (index: number): Snapshot => ({
  id: `id-${index}`,
  key: `event-${index}/`,
  ref: { eventSlug: `event-${index}`, marketSlug: null },
  selectedSlug: null,
  savedAt: 1_000 + index,
  kind: 'binary',
  title: `Market ${index}`,
  eventTitle: null,
  outcome: 'Yes',
  outcomes: [],
  endDate: null,
  summary: { ...summary, at: 1_000 + index },
  volumeLevel: 'NORMAL',
  volumeRatio: 1,
  liquidityLevel: 'HIGH',
  unusual: [],
  factors: [],
  explanation: 'Text.',
  warnings: [],
  series: [],
  seriesRange: '7d',
});

describe('store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('keeps every watchlist item when several are added at once', async () => {
    installFakeChrome();
    const { addWatchItem, loadWatchlist } = await import('../src/storage/store');
    await Promise.all(Array.from({ length: 8 }, (_, index) => addWatchItem(item(index), 50)));
    expect((await loadWatchlist()).map((entry) => entry.key).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `event-${index}/`).sort());
  });

  it('enforces the watchlist limit and removes items', async () => {
    installFakeChrome();
    const { addWatchItem, removeWatchItem, updateWatchItem } = await import('../src/storage/store');
    for (let index = 0; index < 5; index++) expect((await addWatchItem(item(index), 5)).ok).toBe(true);
    expect(await addWatchItem(item(9), 5)).toMatchObject({ ok: false, reason: 'limit' });
    expect((await removeWatchItem('event-0/')).length).toBe(4);
    const updated = await updateWatchItem('event-1/', (entry) => ({ ...entry, alerts: ['Moved +6.0 pp'] }));
    expect(updated.find((entry) => entry.key === 'event-1/')?.alerts).toEqual(['Moved +6.0 pp']);
  });

  it('drops older snapshots instead of failing when storage is full', async () => {
    const { chrome } = installFakeChrome();
    const store = await import('../src/storage/store');
    for (let index = 0; index < 6; index++) await store.saveSnapshot(snapshot(index), 100);
    const set = vi.spyOn(chrome.storage.local, 'set');
    set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    const items = await store.saveSnapshot(snapshot(10), 100);
    expect(items[0]!.id).toBe('id-10');
    expect(items.length).toBe(4);
    await store.deleteSnapshot('id-10');
    expect((await store.loadSnapshots()).map((entry) => entry.id)).not.toContain('id-10');
    await store.clearSnapshots();
    expect(await store.loadSnapshots()).toEqual([]);
  });

  it('reads garbage as defaults', async () => {
    const { local } = installFakeChrome();
    Object.assign(local, { plan: 'enterprise', watchlist: 'x', analysisHistory: [1, 2, 3] });
    const store = await import('../src/storage/store');
    expect(await store.loadPlan()).toBe('free');
    expect(await store.loadWatchlist()).toEqual([]);
    expect(await store.loadSnapshots()).toEqual([]);
    local.plan = 'pro';
    expect(await store.loadPlan()).toBe('pro');
  });

  it('session cache backend stores entries and prunes old ones', async () => {
    const { session } = installFakeChrome();
    const { SessionCacheBackend } = await import('../src/storage/store');
    const backend = new SessionCacheBackend(60_000);
    await backend.set('gamma:event:x', { value: [1], storedAt: 5 });
    expect(await backend.get('gamma:event:x')).toEqual({ value: [1], storedAt: 5 });
    expect(await backend.get('missing')).toBeNull();
    session['cache:broken'] = { storedAt: 'soon' };
    expect(await backend.get('broken')).toBeNull();
    await backend.delete('gamma:event:x');
    expect(await backend.get('gamma:event:x')).toBeNull();
  });
});

describe('context-menu hand-off', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('is read once and expires', async () => {
    const { session } = installFakeChrome();
    const { setPending, takePending } = await import('../src/storage/handoff');
    await setPending({ kind: 'search', query: '  “storms”  ' });
    expect(await takePending()).toMatchObject({ kind: 'search', query: 'storms' });
    expect(await takePending()).toBeNull();
    await setPending({ kind: 'analyze', url: 'https://polymarket.com/event/x' });
    expect(await takePending()).toMatchObject({ kind: 'analyze', url: 'https://polymarket.com/event/x' });
    session.pending = { kind: 'analyze', url: 'https://polymarket.com/event/x', createdAt: Date.now() - 10 * 60_000 };
    expect(await takePending()).toBeNull();
    session.pending = { kind: 'search', query: 'a', createdAt: Date.now() };
    expect(await takePending()).toBeNull();
    session.pending = { kind: 'delete-everything', createdAt: Date.now() };
    expect(await takePending()).toBeNull();
  });
});
