import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** In-memory chrome.storage with async, interleaving reads and writes like the real one. */
function installFakeChrome() {
  const data: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
  const local = {
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
  };
  vi.stubGlobal('chrome', { storage: { local, onChanged: { addListener() {} } } });
  return { data, local };
}

describe('store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('keeps every snippet when several are saved at once', async () => {
    installFakeChrome();
    const { saveSnippet, loadSnippets } = await import('../src/storage/store');
    await Promise.all(Array.from({ length: 8 }, (_, i) => saveSnippet({ abbreviation: `;s${i}`, text: `text ${i}` }, null)));
    const abbreviations = (await loadSnippets()).map((snippet) => snippet.abbreviation).sort();
    expect(abbreviations).toEqual(Array.from({ length: 8 }, (_, i) => `;s${i}`).sort());
  });

  it('validates against what is stored, including concurrent saves', async () => {
    installFakeChrome();
    const { saveSnippet, SnippetValidationError } = await import('../src/storage/store');
    const results = await Promise.allSettled([saveSnippet({ abbreviation: ';dup', text: 'a' }, null), saveSnippet({ abbreviation: ';dup', text: 'b' }, null)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SnippetValidationError);
    expect(rejected.reason.errors.abbreviation).toMatch(/already used/);
  });

  it('updates in place, keeps the id and allows keeping the same abbreviation', async () => {
    installFakeChrome();
    const { saveSnippet, loadSnippets } = await import('../src/storage/store');
    const { snippet } = await saveSnippet({ abbreviation: ';a1', text: 'one', label: 'One' }, null);
    await saveSnippet({ abbreviation: ';a1', text: 'uno', label: 'Uno' }, snippet.id);
    expect(await loadSnippets()).toEqual([{ ...snippet, text: 'uno', label: 'Uno', updatedAt: expect.any(Number) }]);
    await expect(saveSnippet({ abbreviation: ';a2', text: 'x' }, 'missing-id')).rejects.toThrow(/deleted/);
  });

  it('deletes and restores (undo)', async () => {
    installFakeChrome();
    const { saveSnippet, deleteSnippet, restoreSnippet, loadSnippets } = await import('../src/storage/store');
    const { snippet } = await saveSnippet({ abbreviation: ';gone', text: 'x' }, null);
    const removed = await deleteSnippet(snippet.id);
    expect(removed).toEqual(snippet);
    expect(await loadSnippets()).toEqual([]);
    expect(await deleteSnippet(snippet.id)).toBe(null);
    await restoreSnippet(snippet);
    expect(await loadSnippets()).toEqual([snippet]);
  });

  it('seeds starters only when nothing is stored yet', async () => {
    const { data } = installFakeChrome();
    const { seedStarterSnippets, loadSnippets, deleteSnippet } = await import('../src/storage/store');
    expect(await seedStarterSnippets()).toBe(true);
    const seeded = await loadSnippets();
    expect(seeded.map((snippet) => snippet.abbreviation)).toContain(';sig');
    for (const snippet of seeded) await deleteSnippet(snippet.id);
    expect(data.snippets).toEqual([]);
    expect(await seedStarterSnippets()).toBe(false);
    expect(await loadSnippets()).toEqual([]);
  });

  it('turns a quota error into an actionable message', async () => {
    const { local } = installFakeChrome();
    const { saveSnippet } = await import('../src/storage/store');
    vi.spyOn(local, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await expect(saveSnippet({ abbreviation: ';big', text: 'x' }, null)).rejects.toThrow(/storage for Snippets is full/);
  });

  it('toggles sites and sanitizes garbage settings', async () => {
    const { data } = installFakeChrome();
    data.settings = { triggerMode: 'loud', disabledSites: ['Example.com', 42] };
    const { loadSettings, setSiteEnabled, saveSettings } = await import('../src/storage/store');
    expect(await loadSettings()).toEqual({ triggerMode: 'immediate', disabledSites: ['example.com'] });
    expect((await setSiteEnabled('news.site.org', false)).disabledSites).toEqual(['example.com', 'news.site.org']);
    expect((await setSiteEnabled('mail.example.com', true)).disabledSites).toEqual(['news.site.org']);
    await expect(setSiteEnabled('not a host', false)).rejects.toThrow(/isn't a valid site/);
    expect((await saveSettings({ triggerMode: 'delimiter' })).triggerMode).toBe('delimiter');
  });

  it('imports with merge and replace', async () => {
    installFakeChrome();
    const { importSnippets, saveSnippet, loadSnippets } = await import('../src/storage/store');
    await saveSnippet({ abbreviation: ';keep', text: 'x' }, null);
    const merged = await importSnippets([{ abbreviation: ';new', text: 'y', label: '' }], 'merge');
    expect(merged.added).toBe(1);
    expect((await loadSnippets()).map((snippet) => snippet.abbreviation)).toEqual([';keep', ';new']);
    await importSnippets([{ abbreviation: ';only', text: 'z', label: '' }], 'replace');
    expect((await loadSnippets()).map((snippet) => snippet.abbreviation)).toEqual([';only']);
  });

  it('never blocks editing, but blocks adding past the limit (not the free one during early access)', async () => {
    const { data } = installFakeChrome();
    data.snippets = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, abbreviation: `;s${i}`, text: 'x', label: '', createdAt: 1, updatedAt: 1 }));
    const { saveSnippet, loadSnippets } = await import('../src/storage/store');
    // Early access: 25 is fine and more can be added.
    await saveSnippet({ abbreviation: ';more', text: 'y' }, null);
    expect(await loadSnippets()).toHaveLength(26);
    await saveSnippet({ abbreviation: ';s1', text: 'edited' }, 's1');
    expect((await loadSnippets()).find((snippet) => snippet.id === 's1')?.text).toBe('edited');
  });

  it('keeps tags when saving, and keeps existing tags unchanged without the tags feature', async () => {
    const { data } = installFakeChrome();
    const { saveSnippet, loadSnippets } = await import('../src/storage/store');
    const { snippet } = await saveSnippet({ abbreviation: ';t', text: 'x', tags: ['work', 'Work', 'sales'] }, null);
    expect(snippet.tags).toEqual(['work', 'sales']);
    await saveSnippet({ abbreviation: ';t', text: 'x', tags: [] }, snippet.id);
    expect((await loadSnippets())[0]?.tags).toBeUndefined();
    expect(data.plan).toBeUndefined();
  });

  describe('free plan (early access off)', () => {
    beforeEach(() => {
      vi.doMock('../src/core/plan', async (importOriginal) => ({ ...(await importOriginal<object>()), EARLY_ACCESS: false }));
    });
    afterEach(() => vi.doUnmock('../src/core/plan'));

    const stored = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `s${i}`, abbreviation: `;s${i}`, text: 'x', label: '', createdAt: 1, updatedAt: 1 }));

    it('blocks the 21st snippet with a calm message; editing, deleting and undo keep working', async () => {
      const { data } = installFakeChrome();
      data.snippets = stored(19);
      const { saveSnippet, loadSnippets, deleteSnippet, restoreSnippet, SnippetLimitError } = await import('../src/storage/store');
      await saveSnippet({ abbreviation: ';twenty', text: 'y' }, null);
      const blocked = saveSnippet({ abbreviation: ';more', text: 'y' }, null);
      await expect(blocked).rejects.toBeInstanceOf(SnippetLimitError);
      await expect(blocked).rejects.toThrow('Free keeps 20 snippets. Pro removes the limit.');
      await saveSnippet({ abbreviation: ';s1', text: 'edited' }, 's1');
      const removed = await deleteSnippet('s2');
      await restoreSnippet(removed!);
      expect(await loadSnippets()).toHaveLength(20);
    });

    it('keeps snippets over the limit (after a downgrade) and their tags; tags cannot change', async () => {
      const { data } = installFakeChrome();
      data.snippets = [...stored(24), { id: 't', abbreviation: ';t', text: 'x', label: '', tags: ['work'], createdAt: 1, updatedAt: 1 }];
      const { saveSnippet, loadSnippets, importSnippets } = await import('../src/storage/store');
      expect(await loadSnippets()).toHaveLength(25);
      await saveSnippet({ abbreviation: ';t', text: 'changed', tags: ['other'] }, 't');
      const saved = (await loadSnippets()).find((snippet) => snippet.id === 't');
      expect(saved).toMatchObject({ text: 'changed', tags: ['work'] });
      await expect(importSnippets([{ abbreviation: ';new', text: 'x', label: '' }], 'merge')).rejects.toThrow(/limit/);
      expect((await importSnippets([{ abbreviation: ';s3', text: 'updated', label: '' }], 'merge')).updated).toBe(1);
      expect(await loadSnippets()).toHaveLength(25);
    });

    it('a stored "pro" plan lifts the limit', async () => {
      const { data } = installFakeChrome();
      data.snippets = stored(20);
      data.plan = 'pro';
      const { saveSnippet, loadSnippets, loadPlanState } = await import('../src/storage/store');
      expect(await loadPlanState()).toEqual({ plan: 'pro', earlyAccess: false });
      await saveSnippet({ abbreviation: ';more', text: 'y', tags: ['a'] }, null);
      expect(await loadSnippets()).toHaveLength(21);
    });
  });
});
