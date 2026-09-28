import { describe, expect, it } from 'vitest';
import { LAST_COPY_LIMITS, prepareLastCopy, sanitizeLastCopy, timeAgo, viaLabel } from '../src/core/lastCopy';

const base = { via: 'menu' as const, original: { text: 'Original​ text', html: '<b>Original</b> text' }, cleaned: 'Original text', summary: '13 characters' };

describe('last copy (kept for Undo and Show changes)', () => {
  it('keeps the original, the clean text and the changes', () => {
    const copy = prepareLastCopy({ ...base, id: 'c1', at: 5, host: 'news.example.com', changes: [{ text: 'Original' }, { text: '​', op: 'del', kind: 'invisible' }, { text: ' text' }] });
    expect(copy).toEqual({
      id: 'c1',
      at: 5,
      via: 'menu',
      host: 'news.example.com',
      original: { text: 'Original​ text', html: '<b>Original</b> text' },
      cleaned: 'Original text',
      length: 13,
      summary: '13 characters',
      changes: [{ text: 'Original' }, { text: '​', op: 'del', kind: 'invisible' }, { text: ' text' }],
    });
    expect(sanitizeLastCopy(JSON.parse(JSON.stringify(copy)))).toEqual(copy);
  });

  it('leaves out what is too large instead of cutting it', () => {
    const hugeHtml = prepareLastCopy({ ...base, original: { text: 'a', html: 'x'.repeat(LAST_COPY_LIMITS.maxOriginalHtml + 1) } });
    expect(hugeHtml.original).toEqual({ text: 'a' });
    expect(prepareLastCopy({ ...base, original: { text: 'x'.repeat(LAST_COPY_LIMITS.maxOriginalText + 1) } }).original).toBeNull();
    const bigClean = prepareLastCopy({ ...base, cleaned: 'y'.repeat(LAST_COPY_LIMITS.maxCleaned + 1) });
    expect(bigClean.cleaned).toBe('');
    expect(bigClean.length).toBe(LAST_COPY_LIMITS.maxCleaned + 1);
    expect(prepareLastCopy({ ...base, changes: [{ text: 'z'.repeat(LAST_COPY_LIMITS.maxChanges + 1) }] }).changes).toBeUndefined();
    expect(prepareLastCopy({ ...base, changes: null }).changes).toBeUndefined();
  });

  it('rejects malformed stored or sent copies', () => {
    const good = prepareLastCopy({ ...base, id: 'c2', at: 1 });
    for (const bad of [null, 'x', { ...good, id: '<script>' }, { ...good, via: 'evil' }, { ...good, at: 'now' }, { ...good, cleaned: 1 }]) {
      expect(sanitizeLastCopy(bad)).toBeNull();
    }
    expect(sanitizeLastCopy({ ...good, host: 'not a host!' })?.host).toBeUndefined();
    expect(sanitizeLastCopy({ ...good, original: { text: 5 } })?.original).toBeNull();
    expect(sanitizeLastCopy({ ...good, changes: [{ text: 1 }] })?.changes).toBeUndefined();
    expect(sanitizeLastCopy({ ...good, restoredAt: 9 })?.restoredAt).toBe(9);
  });

  it('describes when and how', () => {
    expect(timeAgo(0, 10_000)).toBe('just now');
    expect(timeAgo(0, 5 * 60_000)).toBe('5 min ago');
    expect(timeAgo(0, 2 * 3_600_000)).toBe('2 h ago');
    expect(timeAgo(0, 26 * 3_600_000)).toBe('1 day ago');
    expect(viaLabel('auto')).toBe('Auto-clean on Ctrl+C');
    expect(viaLabel('clipboard')).toBe('Clean clipboard');
  });
});
