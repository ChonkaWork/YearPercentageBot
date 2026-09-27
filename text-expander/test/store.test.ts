import { beforeEach, describe, expect, it, vi } from 'vitest';

/** In-memory chrome.storage with async, interleaving reads and writes like the real one. */
function installFakeChrome() {
  const data: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
  const local = {
    async get(key: string) {
      await tick();
      return key in data ? { [key]: structuredClone(data[key]) } : {};
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
});
