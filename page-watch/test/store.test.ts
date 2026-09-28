import { beforeEach, describe, expect, it, vi } from 'vitest';

/** In-memory chrome.storage with async, interleaving reads and writes like the real one. */
function installFakeChrome() {
  const data: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
  const area = {
    async get(keys: string | string[]) {
      await tick();
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      await tick();
      Object.assign(data, structuredClone(items));
    },
    async remove(keys: string | string[]) {
      await tick();
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
  vi.stubGlobal('chrome', { storage: { local: area, session: area } });
  return data;
}

const watch = (id: string) => ({ id, url: `https://example.com/${id}`, name: id, paused: false });

describe('store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('serializes read-modify-write updates so none are lost', async () => {
    const data = installFakeChrome();
    data.watches = [watch('a'), watch('b')];
    const store = await import('../src/storage/store');
    await Promise.all([
      store.updateWatch('a', (w) => ({ ...w, name: 'A1' })),
      store.updateWatch('b', (w) => ({ ...w, paused: true })),
      store.updateWatch('a', (w) => ({ ...w, unseen: 3 })),
    ]);
    const watches = await store.loadWatches();
    expect(watches.find((w) => w.id === 'a')).toMatchObject({ name: 'A1', unseen: 3 });
    expect(watches.find((w) => w.id === 'b')).toMatchObject({ paused: true });
  });

  it('sanitizes what it reads', async () => {
    const data = installFakeChrome();
    data.watches = [watch('ok'), { id: 'bad', url: 'ftp://x' }, 'garbage'];
    data['changes:ok'] = [{ id: 'c', summary: 's', lines: [{ type: 'evil', text: 'x' }, { type: 'add', text: 'y' }] }];
    data.settings = { notifyChanges: 'yes', defaultIntervalMinutes: 15 };
    const store = await import('../src/storage/store');
    expect((await store.loadWatches()).map((w) => w.id)).toEqual(['ok']);
    expect((await store.loadChanges('ok'))[0]!.lines).toEqual([{ type: 'add', text: 'y' }]);
    expect(await store.loadSettings()).toEqual({
      notifyChanges: true,
      notifyErrors: true,
      defaultIntervalMinutes: 15,
      quietHours: { enabled: false, start: 22 * 60, end: 7 * 60 },
    });
    expect(await store.loadSnapshot('missing')).toBeNull();
  });

  it('keeps a pending add only while it is fresh and only clears its own', async () => {
    const data = installFakeChrome();
    const store = await import('../src/storage/store');
    const pending = { id: 'p1', kind: 'page' as const, tabId: 1, url: 'https://example.com', createdAt: Date.now() };
    await store.setPendingAdd(pending);
    await store.clearPendingAdd('other');
    expect(await store.loadPendingAdd()).toEqual(pending);
    await store.clearPendingAdd('p1');
    expect(await store.loadPendingAdd()).toBeNull();
    data.pendingAdd = { ...pending, createdAt: Date.now() - 10 * 60_000 };
    expect(await store.loadPendingAdd()).toBeNull();
  });

  it('forgets stale "checking" markers', async () => {
    const store = await import('../src/storage/store');
    expect(store.sanitizeChecking({ a: 1000, b: 'x', c: 95_000 }, 100_000)).toEqual({ c: 95_000 });
  });

  it('removes a watch\'s data', async () => {
    const data = installFakeChrome();
    data['snapshot:x'] = { text: 'a' };
    data['changes:x'] = [];
    data['snapshot:y'] = { text: 'b' };
    const store = await import('../src/storage/store');
    await store.removeWatchData('x');
    expect(Object.keys(data)).toEqual(['snapshot:y']);
  });
});

describe('message guards', () => {
  it('accepts well-formed requests only', async () => {
    const { isBackgroundRequest, isExtractRequest, isPickerStartMessage } = await import('../src/platform/messages');
    expect(isBackgroundRequest({ type: 'pw/check-now', id: 'x' })).toBe(true);
    expect(isBackgroundRequest({ type: 'pw/check-now' })).toBe(false);
    expect(isBackgroundRequest({ type: 'pw/mark-seen', id: null })).toBe(true);
    expect(isBackgroundRequest({ type: 'pw/set-paused', id: 'x', paused: 'yes' })).toBe(false);
    expect(isBackgroundRequest({ type: 'pw/complete-add', pending: { id: 'p', kind: 'pick', tabId: 1, url: 'u', createdAt: 1 } })).toBe(true);
    expect(isBackgroundRequest({ type: 'pw/complete-add', pending: { id: 'p', kind: 'evil', tabId: 1, url: 'u', createdAt: 1 } })).toBe(false);
    expect(isBackgroundRequest({ type: 'pw/unknown' })).toBe(false);
    expect(isBackgroundRequest(null)).toBe(false);
    expect(isExtractRequest({ target: 'offscreen', type: 'pw/extract', html: '', selectors: null })).toBe(true);
    expect(isExtractRequest({ target: 'offscreen', type: 'pw/extract', html: '', selectors: [1] })).toBe(false);
    expect(isPickerStartMessage({ type: 'pw/picker-start', title: 't', intervalMinutes: 60 })).toBe(true);
  });
});

describe('plan storage', () => {
  it('reads the stored plan, sanitized, free by default', async () => {
    const data = installFakeChrome();
    vi.resetModules();
    const store = await import('../src/storage/store');
    expect(await store.loadPlan()).toBe('free');
    data.plan = 'pro';
    expect(await store.loadPlan()).toBe('pro');
    data.plan = 'enterprise';
    expect(await store.loadPlan()).toBe('free');
    expect(store.planChanged({ plan: {} })).toBe(true);
    expect(store.planChanged({ settings: {} })).toBe(false);
  });

  it('keeps held notifications and removes the key when empty', async () => {
    const data = installFakeChrome();
    vi.resetModules();
    const store = await import('../src/storage/store');
    expect(await store.loadHeld()).toEqual([]);
    await store.saveHeld([{ kind: 'change', watchId: 'a', name: 'A', text: 't', at: 1 }]);
    expect(await store.loadHeld()).toHaveLength(1);
    await store.saveHeld([]);
    expect('heldNotifications' in data).toBe(false);
  });
});
