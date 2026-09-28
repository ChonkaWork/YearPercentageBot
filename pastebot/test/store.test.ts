import { beforeEach, describe, expect, it, vi } from 'vitest';

/** In-memory chrome.storage with async, interleaving reads and writes like the real one. */
function installFakeChrome() {
  const data: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
  const area = {
    async get(keys: string | string[]) {
      await tick();
      const result: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) if (key in data) result[key] = structuredClone(data[key]);
      return result;
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

describe('store: plan, templates, pins', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('reads the stored plan sanitized, default free', async () => {
    const data = installFakeChrome();
    const { loadPlanState } = await import('../src/storage/store');
    expect((await loadPlanState()).plan).toBe('free');
    data.plan = 'lifetime-hacker';
    expect((await loadPlanState()).plan).toBe('free');
    data.plan = 'pro';
    const state = await loadPlanState();
    expect(state.plan).toBe('pro');
    expect(state.limits.maxHistoryItems).toBe(500);
  });

  it('ignores the e2e early-access override outside the e2e build', async () => {
    const data = installFakeChrome();
    data.e2eEarlyAccess = false;
    const { loadPlanState } = await import('../src/storage/store');
    expect((await loadPlanState()).earlyAccess).toBe(true);
  });

  it('saves templates sanitized', async () => {
    const data = installFakeChrome();
    const { loadTemplates, saveTemplates } = await import('../src/storage/store');
    await saveTemplates([{ id: 'a', name: ' Email ', instruction: 'Rewrite {content}' }, { id: 'a', name: 'Dup', instruction: 'x' }]);
    expect(data.customTemplates).toEqual([{ id: 'a', name: 'Email', instruction: 'Rewrite {content}' }]);
    expect(await loadTemplates()).toHaveLength(1);
    data.customTemplates = 'garbage';
    expect(await loadTemplates()).toEqual([]);
  });

  it('keeps pinned prompts through the history limit, clear all and a smaller setting', async () => {
    installFakeChrome();
    const store = await import('../src/storage/store');
    const first = await store.addHistoryItem({ action: 'explain', prompt: 'keep me' }, 3);
    await store.setHistoryPinned(first!.id, true);
    for (let i = 0; i < 5; i++) await store.addHistoryItem({ action: 'explain', prompt: `p${i}` }, 3);
    expect((await store.loadHistory()).map((item) => item.prompt)).toEqual(['p4', 'p3', 'keep me']);
    await store.saveSettings({ maxHistoryItems: 0 });
    expect((await store.loadHistory()).map((item) => item.prompt)).toEqual(['keep me']);
    await store.saveSettings({ maxHistoryItems: 20 });
    await store.addHistoryItem({ action: 'explain', prompt: 'new' }, 20);
    await store.clearHistory();
    expect((await store.loadHistory()).map((item) => item.prompt)).toEqual(['keep me']);
  });

  it('does not delete saved prompts when the plan limit drops below them', async () => {
    const data = installFakeChrome();
    const store = await import('../src/storage/store');
    const { limitsFor } = await import('../src/core/plan');
    for (let i = 0; i < 30; i++) await store.addHistoryItem({ action: 'explain', prompt: `p${i}` }, 100, limitsFor('pro', false));
    await store.addHistoryItem({ action: 'explain', prompt: 'after' }, 100, limitsFor('free', false));
    const items = await store.loadHistory();
    expect(items).toHaveLength(30);
    expect(items[0]?.prompt).toBe('after');
    expect((data.history as unknown[]).length).toBe(30);
  });
});

describe('store: settings', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('keeps every field when changes are saved concurrently', async () => {
    installFakeChrome();
    const { loadSettings, saveSettings } = await import('../src/storage/store');
    await Promise.all([
      saveSettings({ defaultAction: 'explain' }),
      saveSettings({ maxHistoryItems: 500 }),
      saveSettings({ promptStyle: 'concise' }),
      saveSettings({ includePageContext: true }),
    ]);
    expect(await loadSettings()).toEqual({ includePageContext: true, defaultAction: 'explain', promptStyle: 'concise', maxHistoryItems: 500 });
  });
});
