import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entry } from './entries';

/** In-memory chrome.storage with async, interleaving reads and writes like the real one. */
function installFakeChrome() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
  const area = (data: Record<string, unknown>) => ({
    async get(key: string) {
      await tick();
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items: Record<string, unknown>) {
      await tick();
      Object.assign(data, structuredClone(items));
    },
    async remove(key: string) {
      await tick();
      delete data[key];
    },
  });
  vi.stubGlobal('chrome', { storage: { local: area(local), session: area(session) } });
  return { local, session };
}

describe('store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('keeps every entry when analyses are saved concurrently', async () => {
    installFakeChrome();
    const { addHistoryEntry, loadHistory } = await import('../src/storage/store');
    await Promise.all(Array.from({ length: 6 }, (_, i) => addHistoryEntry(entry(`e${i}`, { symbol: `C${i}` }), 20)));
    expect((await loadHistory()).map((item) => item.id).sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('drops older entries instead of failing when storage is full', async () => {
    installFakeChrome();
    const store = await import('../src/storage/store');
    for (let i = 0; i < 6; i++) await store.addHistoryEntry(entry(`e${i}`, { symbol: `C${i}` }), 20);
    const set = vi.spyOn((globalThis as unknown as { chrome: { storage: { local: { set: () => Promise<void> } } } }).chrome.storage.local, 'set');
    set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    expect(await store.addHistoryEntry(entry('newest', { symbol: 'NEW' }), 20)).toBe(true);
    const items = await store.loadHistory();
    expect(items[0]?.id).toBe('newest');
    expect(items).toHaveLength(4);
  });

  it('stores nothing when history is off, and trims when the limit shrinks', async () => {
    const { local } = installFakeChrome();
    const store = await import('../src/storage/store');
    expect(await store.addHistoryEntry(entry('x'), 0)).toBe(false);
    expect(local.history).toBeUndefined();
    for (let i = 0; i < 4; i++) await store.addHistoryEntry(entry(`e${i}`, { symbol: `C${i}` }), 20);
    await store.saveSettings({ historyLimit: 2 } as never);
    expect((await store.loadHistory()).map((item) => item.id)).toEqual(['e3', 'e2']);
  });

  it('falls back to defaults when settings hold garbage', async () => {
    const { local } = installFakeChrome();
    local.settings = { detectFromPage: 'no', historyLimit: 'lots' };
    const { loadSettings } = await import('../src/storage/store');
    expect(await loadSettings()).toEqual({ detectFromPage: true, historyLimit: 20, previewFreePlan: false });
  });

  it('hands a context-menu request to the popup once, and ignores old ones', async () => {
    const { session } = installFakeChrome();
    const store = await import('../src/storage/store');
    await store.setPendingAnalysis({ symbol: 'SOL', selection: 'Solana' });
    expect(await store.takePendingAnalysis()).toMatchObject({ symbol: 'SOL', selection: 'Solana' });
    expect(await store.takePendingAnalysis()).toBeNull();
    session.pendingAnalysis = { symbol: 'SOL', selection: 'x', createdAt: Date.now() - 10 * 60_000 };
    expect(await store.takePendingAnalysis()).toBeNull();
    session.pendingAnalysis = { symbol: '<script>', selection: 'x', createdAt: Date.now() };
    expect(await store.takePendingAnalysis()).toMatchObject({ symbol: null });
  });

  it('counts analyses per day', async () => {
    installFakeChrome();
    const store = await import('../src/storage/store');
    const now = new Date(2026, 8, 27, 10).getTime();
    await store.recordAnalysis(now);
    await store.recordAnalysis(now);
    expect(await store.loadUsage(now)).toEqual({ day: '2026-09-27', count: 2 });
    expect(await store.loadUsage(now + 24 * 3_600_000)).toEqual({ day: '2026-09-28', count: 0 });
  });

  it('hands an alert click to the popup with its market and message', async () => {
    const { session } = installFakeChrome();
    const store = await import('../src/storage/store');
    await store.setPendingAnalysis({ symbol: 'BTC', selection: '', interval: '1d', alert: 'BTC (1d) signal is now Bearish.' });
    expect(await store.takePendingAnalysis()).toMatchObject({ symbol: 'BTC', interval: '1d', alert: 'BTC (1d) signal is now Bearish.' });
    session.pendingAnalysis = { symbol: 'BTC', selection: '', interval: '5m', alert: 7, createdAt: Date.now() };
    expect(await store.takePendingAnalysis()).toMatchObject({ symbol: 'BTC', interval: null, alert: null });
  });

  it('keeps every alert when several are created at once, and reads the plan safely', async () => {
    const { local } = installFakeChrome();
    const store = await import('../src/storage/store');
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.updateAlerts((rules) => [...rules, { id: `a${i}`, symbol: 'BTC', interval: '4h', condition: { type: 'signal-changed' }, enabled: true, createdAt: i }]),
      ),
    );
    expect((await store.loadAlerts()).map((rule) => rule.id).sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    expect(await store.loadPlan()).toBe('free');
    local.plan = 'pro';
    expect(await store.loadPlan()).toBe('pro');
    local.plan = 'enterprise';
    expect(await store.loadPlan()).toBe('free');
  });
});
