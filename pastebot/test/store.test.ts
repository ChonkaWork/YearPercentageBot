import { beforeEach, describe, expect, it, vi } from 'vitest';

/** In-memory chrome.storage with async, interleaving reads and writes like the real one. */
function installFakeChrome() {
  const data: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
  const area = {
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
  };
  vi.stubGlobal('chrome', { storage: { local: area, session: area } });
  return data;
}

describe('store: history', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('keeps every item when prompts are saved concurrently', async () => {
    installFakeChrome();
    const { addHistoryItem, loadHistory } = await import('../src/storage/store');
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => addHistoryItem({ action: 'summarize', prompt: `prompt ${i}` }, 20)),
    );
    const prompts = (await loadHistory()).map((item) => item.prompt).sort();
    expect(prompts).toEqual(Array.from({ length: 8 }, (_, i) => `prompt ${i}`).sort());
  });

  it('drops older items instead of failing when storage is full', async () => {
    installFakeChrome();
    const store = await import('../src/storage/store');
    for (let i = 0; i < 6; i++) await store.addHistoryItem({ action: 'explain', prompt: `p${i}` }, 20);
    const set = vi.spyOn((globalThis as unknown as { chrome: { storage: { local: { set: () => Promise<void> } } } }).chrome.storage.local, 'set');
    set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    const item = await store.addHistoryItem({ action: 'explain', prompt: 'newest' }, 20);
    const items = await store.loadHistory();
    expect(item?.prompt).toBe('newest');
    expect(items[0]?.prompt).toBe('newest');
    expect(items.length).toBe(4);
  });

  it('does not store anything when history is off', async () => {
    const data = installFakeChrome();
    const { addHistoryItem } = await import('../src/storage/store');
    expect(await addHistoryItem({ action: 'explain', prompt: 'p' }, 0)).toBeNull();
    expect(data.history).toBeUndefined();
  });

  it('falls back to default settings when storage holds garbage', async () => {
    const data = installFakeChrome();
    data.settings = { promptStyle: 'loud', maxHistoryItems: -3, includePageContext: 'yes' };
    const { loadSettings } = await import('../src/storage/store');
    expect(await loadSettings()).toEqual({
      includePageContext: false,
      defaultAction: 'analyze',
      promptStyle: 'balanced',
      maxHistoryItems: 0,
    });
  });
});
