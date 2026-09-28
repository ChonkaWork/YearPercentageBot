import { describe, expect, it } from 'vitest';
import {
  addToHistory,
  clearUnpinned,
  createHistoryItem,
  orderForDisplay,
  removeFromHistory,
  replacePrompt,
  sanitizeHistory,
  searchHistory,
  setPinned,
  trimHistory,
} from '../src/core/history';
import { MAX_INPUT_CHARS, truncateToLimit } from '../src/core/limits';
import { sanitizePageContext, sanitizeUrl } from '../src/core/pageContext';
import { DEFAULT_SETTINGS, MAX_HISTORY_LIMIT, sanitizeSettings } from '../src/core/settings';

describe('sanitizeSettings', () => {
  it('returns defaults for garbage', () => {
    for (const raw of [undefined, null, 42, 'x', [], {}]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and fixes invalid ones per field', () => {
    expect(
      sanitizeSettings({ includePageContext: true, defaultAction: 'custom', promptStyle: 'detailed', maxHistoryItems: '7' }),
    ).toEqual({ ...DEFAULT_SETTINGS, includePageContext: true, defaultAction: DEFAULT_SETTINGS.defaultAction, promptStyle: 'detailed', maxHistoryItems: 7 });
  });

  it('clamps the history size', () => {
    expect(sanitizeSettings({ maxHistoryItems: -5 }).maxHistoryItems).toBe(0);
    expect(sanitizeSettings({ maxHistoryItems: 10_000 }).maxHistoryItems).toBe(MAX_HISTORY_LIMIT);
    expect(sanitizeSettings({ maxHistoryItems: Number.NaN }).maxHistoryItems).toBe(DEFAULT_SETTINGS.maxHistoryItems);
    expect(sanitizeSettings({ maxHistoryItems: 3.6 }).maxHistoryItems).toBe(4);
  });
});

describe('history', () => {
  const item = (id: string) => createHistoryItem({ action: 'summarize', prompt: `prompt ${id}` }, id, 1);

  it('adds newest first and caps the size', () => {
    let items = [item('a'), item('b')];
    items = addToHistory(items, item('c'), 2);
    expect(items.map((entry) => entry.id)).toEqual(['c', 'a']);
  });

  it('returns nothing when history is disabled', () => {
    expect(addToHistory([item('a')], item('b'), 0)).toEqual([]);
  });

  it('removes and replaces items', () => {
    const items = [item('a'), item('b')];
    expect(removeFromHistory(items, 'a').map((entry) => entry.id)).toEqual(['b']);
    expect(replacePrompt(items, 'b', 'edited')[1]?.prompt).toBe('edited');
  });

  it('stores page info only when present', () => {
    const withPage = createHistoryItem({ action: 'explain', prompt: 'p', page: { title: 'T', url: 'https://x.dev' } }, 'id', 5);
    expect(withPage).toEqual({ id: 'id', timestamp: 5, action: 'explain', prompt: 'p', pageTitle: 'T', pageUrl: 'https://x.dev' });
    expect(createHistoryItem({ action: 'explain', prompt: 'p', page: null }, 'id', 5)).not.toHaveProperty('pageTitle');
  });

  it('drops malformed stored items', () => {
    const stored = [item('ok'), { id: 1 }, null, { id: 'x', timestamp: 1, prompt: 'p', action: 'nope' }, 'junk'];
    expect(sanitizeHistory(stored).map((entry) => entry.id)).toEqual(['ok']);
    expect(sanitizeHistory({})).toEqual([]);
  });
});

describe('page context', () => {
  it('removes tracking and secret-looking parameters', () => {
    expect(sanitizeUrl('https://user:pw@shop.example/item/42?utm_source=x&color=red&fbclid=1&access_token=abc&session_id=9')).toBe(
      'https://shop.example/item/42?color=red',
    );
  });

  it('keeps useful fragments and drops token fragments', () => {
    expect(sanitizeUrl('https://github.com/a/b/blob/main/x.ts#L10-L20')).toBe('https://github.com/a/b/blob/main/x.ts#L10-L20');
    expect(sanitizeUrl('https://app.example/cb#access_token=secret&state=1')).toBe('https://app.example/cb');
  });

  it('rejects non-web URLs and garbage', () => {
    for (const url of ['chrome://settings', 'file:///etc/passwd', 'chrome-extension://abc/popup.html', 'not a url', '']) {
      expect(sanitizeUrl(url)).toBeUndefined();
    }
  });

  it('normalizes titles and drops empty context', () => {
    expect(sanitizePageContext({ title: '  Senior\n  Java   Developer ', url: 'about:blank' })).toEqual({ title: 'Senior Java Developer' });
    expect(sanitizePageContext({ title: '   ' })).toBeNull();
    expect(sanitizePageContext({ title: 'x'.repeat(500) })?.title).toHaveLength(200);
  });
});

describe('truncateToLimit', () => {
  it('returns short text untouched', () => {
    expect(truncateToLimit('hello', 10)).toBe('hello');
  });

  it('cuts at a line or word boundary near the limit', () => {
    const text = `${'word '.repeat(30)}\n${'tail '.repeat(30)}`;
    const cut = truncateToLimit(text, 160);
    expect(cut.length).toBeLessThanOrEqual(160);
    expect(cut.endsWith('tail') || cut.endsWith('word')).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const cut = truncateToLimit(`${'a'.repeat(9)}😀😀`, 10);
    expect(cut).toBe('a'.repeat(9));
  });

  it('defaults to the input limit', () => {
    expect(truncateToLimit('x'.repeat(MAX_INPUT_CHARS + 50)).length).toBe(MAX_INPUT_CHARS);
  });
});

describe('history: pins and search', () => {
  const at = (id: string, extra: Partial<Parameters<typeof createHistoryItem>[0]> = {}, pinned = false) => {
    const item = createHistoryItem({ action: 'summarize', prompt: `prompt ${id}`, ...extra }, id, 1);
    return pinned ? { ...item, pinned: true as const } : item;
  };

  it('never rotates pinned items out, and always keeps the new one', () => {
    const items = [at('b'), at('c', {}, true), at('d')];
    expect(addToHistory(items, at('a'), 2).map((item) => item.id)).toEqual(['a', 'c']);
    expect(addToHistory([at('p', {}, true), at('q', {}, true)], at('n'), 2).map((item) => item.id)).toEqual(['n', 'p', 'q']);
    expect(trimHistory(items, 0).map((item) => item.id)).toEqual(['c']);
    expect(addToHistory(items, at('a'), 0).map((item) => item.id)).toEqual(['c']);
  });

  it('pins, unpins and shows pinned first', () => {
    let items = [at('a'), at('b'), at('c')];
    items = setPinned(items, 'c', true);
    expect(items[2]?.pinned).toBe(true);
    expect(orderForDisplay(items).map((item) => item.id)).toEqual(['c', 'a', 'b']);
    items = setPinned(items, 'c', false);
    expect(items[2]).not.toHaveProperty('pinned');
    expect(clearUnpinned(setPinned(items, 'b', true)).map((item) => item.id)).toEqual(['b']);
  });

  it('keeps pins and template names through storage sanitizing', () => {
    const stored = [{ ...at('a', { templateName: 'Email' }), pinned: true }, { ...at('b'), pinned: 'yes', templateName: 3 }];
    const [first, second] = sanitizeHistory(stored);
    expect(first).toMatchObject({ pinned: true, templateName: 'Email' });
    expect(second).not.toHaveProperty('pinned');
    expect(second).not.toHaveProperty('templateName');
  });

  it('searches prompt, page, source and action/template name; every word must match', () => {
    const items = [
      at('1', { prompt: 'Explain NullPointerException', page: { title: 'Stack Overflow', url: 'https://stackoverflow.com/q/1' } }),
      at('2', { prompt: 'Summarize the rate decision', sourceText: 'The central bank raised rates' }),
      at('3', { action: 'custom', prompt: 'Rewrite as email', templateName: 'Email to team' }),
    ];
    const ids = (query: string) => searchHistory(items, query).map((item) => item.id);
    expect(ids('')).toEqual(['1', '2', '3']);
    expect(ids('nullpointer')).toEqual(['1']);
    expect(ids('stackoverflow.com')).toEqual(['1']);
    expect(ids('central bank')).toEqual(['2']);
    expect(ids('email team')).toEqual(['3']);
    // Action label: items 1 and 2 were made with Summarize; 3 shows its template name instead.
    expect(ids('summarize')).toEqual(['1', '2']);
    expect(ids('rate  explain')).toEqual([]);
  });
});
