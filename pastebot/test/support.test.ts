import { describe, expect, it } from 'vitest';
import { addToHistory, createHistoryItem, removeFromHistory, replacePrompt, sanitizeHistory } from '../src/core/history';
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
    ).toEqual({ includePageContext: true, defaultAction: DEFAULT_SETTINGS.defaultAction, promptStyle: 'detailed', maxHistoryItems: 7 });
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
