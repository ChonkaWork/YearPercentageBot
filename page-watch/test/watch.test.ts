import { describe, expect, it } from 'vitest';
import { checkError } from '../src/core/errors';
import { MINUTE_MS } from '../src/core/schedule';
import type { Change, Snapshot, Watch } from '../src/core/types';
import {
  applyCheck,
  applyPatch,
  createWatch,
  markSeen,
  MAX_CHANGES,
  sanitizeChanges,
  sanitizeWatch,
  sanitizeWatches,
  setPaused,
  sortWatches,
  totalUnseen,
  validateDraft,
  validatePatch,
} from '../src/core/watch';

const noJitter = () => 0.5;
const NOW = 1_700_000_000_000;

function watch(overrides: Partial<Watch> = {}): Watch {
  return {
    ...createWatch({ url: 'https://shop.example.com/p/1', name: 'Widget', selector: '#price', intervalMinutes: 60, mode: 'text', keyword: '' }, 'w1', NOW - 1000),
    status: 'unchanged',
    ...overrides,
  };
}

const snapshot = (text: string): Snapshot => ({ text, at: NOW - 1000, truncated: false });
const context = (changeId = 'c1') => ({ now: NOW, random: noJitter, changeId });

describe('applyCheck', () => {
  it('stores the first snapshot without recording a change', () => {
    const result = applyCheck(watch({ status: 'pending' }), null, [], { ok: true, text: '$10', truncated: false }, context());
    expect(result.change).toBeNull();
    expect(result.snapshot?.text).toBe('$10');
    expect(result.watch.status).toBe('unchanged');
    expect(result.watch.nextCheckAt).toBe(NOW + 60 * MINUTE_MS);
  });

  it('records a change, counts it as unseen and moves the baseline', () => {
    const result = applyCheck(watch(), snapshot('$10'), [], { ok: true, text: '$12', truncated: false }, context());
    expect(result.change?.summary).toBe('Changed: “$10” → “$12”');
    expect(result.watch).toMatchObject({ status: 'changed', unseen: 1, lastChangedAt: NOW, lastSummary: result.change?.summary });
    expect(result.snapshot?.text).toBe('$12');
    expect(result.changes).toHaveLength(1);
  });

  it('moves the baseline silently when the rule says it is not a change', () => {
    const numberWatch = watch({ mode: 'number' });
    const result = applyCheck(numberWatch, snapshot('$10 in stock'), [], { ok: true, text: '$10 low stock', truncated: false }, context());
    expect(result.change).toBeNull();
    expect(result.snapshot?.text).toBe('$10 low stock');
    expect(result.watch.status).toBe('unchanged');
  });

  it('keeps only the last changes', () => {
    const old: Change[] = Array.from({ length: MAX_CHANGES }, (_, i) => ({
      id: `old${i}`,
      at: i,
      summary: 's',
      added: 1,
      removed: 0,
      lines: [],
      truncated: false,
      seen: i > 2,
    }));
    const result = applyCheck(watch({ unseen: 3 }), snapshot('a'), old, { ok: true, text: 'b', truncated: false }, context('new'));
    expect(result.changes).toHaveLength(MAX_CHANGES);
    expect(result.changes[0]!.id).toBe('new');
    expect(result.watch.unseen).toBe(4);
  });

  it('backs off on repeated errors and notifies persistent errors once', () => {
    let current = watch();
    const delays: number[] = [];
    const notified: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const result = applyCheck(current, snapshot('a'), [], { ok: false, error: checkError('selector') }, context());
      current = result.watch;
      delays.push((current.nextCheckAt! - NOW) / MINUTE_MS);
      notified.push(result.notifyError);
    }
    expect(delays).toEqual([60, 120, 240, 480]);
    expect(notified).toEqual([true, false, false, false]);
    expect(current).toMatchObject({ status: 'error', errorCount: 4, errorNotified: true });
    expect(current.error?.code).toBe('selector');
  });

  it('notifies transient errors only when they persist', () => {
    let current = watch();
    const notified: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const result = applyCheck(current, snapshot('a'), [], { ok: false, error: checkError('http', { status: 503 }) }, context());
      current = result.watch;
      notified.push(result.notifyError);
    }
    expect(notified).toEqual([false, false, true, false]);
  });

  it('respects Retry-After and resets everything after a success', () => {
    const failed = applyCheck(watch({ intervalMinutes: 5 }), snapshot('a'), [], { ok: false, error: checkError('http', { status: 429, retryAfterSeconds: 3600 }) }, context());
    expect(failed.watch.nextCheckAt! - NOW).toBe(60 * MINUTE_MS);
    const recovered = applyCheck(failed.watch, snapshot('a'), [], { ok: true, text: 'a', truncated: false }, context());
    expect(recovered.watch).toMatchObject({ error: null, errorCount: 0, errorNotified: false, status: 'unchanged' });
    expect(recovered.watch.nextCheckAt! - NOW).toBe(5 * MINUTE_MS);
  });

  it('does not schedule paused watches', () => {
    const result = applyCheck(watch({ paused: true }), snapshot('a'), [], { ok: true, text: 'b', truncated: false }, context());
    expect(result.watch.nextCheckAt).toBeNull();
  });
});

describe('user edits', () => {
  it('marks everything seen', () => {
    const changes = sanitizeChanges([{ id: 'a', seen: false }, { id: 'b', seen: true }]);
    const result = markSeen(watch({ unseen: 1 }), changes);
    expect(result.watch.unseen).toBe(0);
    expect(result.changes.every((change) => change.seen)).toBe(true);
  });

  it('applies a patch and reschedules on interval change', () => {
    const next = applyPatch(watch(), { name: 'New', intervalMinutes: 5, mode: 'keyword', keyword: 'Sold out' }, NOW, noJitter);
    expect(next).toMatchObject({ name: 'New', intervalMinutes: 5, mode: 'keyword', keyword: 'Sold out', nextCheckAt: NOW + 5 * MINUTE_MS });
    expect(applyPatch(next, { mode: 'text' }, NOW, noJitter).keyword).toBe('');
  });

  it('pauses and resumes', () => {
    const paused = setPaused(watch({ nextCheckAt: NOW + 1 }), true, NOW, noJitter);
    expect(paused).toMatchObject({ paused: true, nextCheckAt: null });
    expect(setPaused(paused, false, NOW, noJitter)).toMatchObject({ paused: false, nextCheckAt: NOW + 60 * MINUTE_MS });
  });

  it('sorts unseen first, then newest', () => {
    const a = watch({ id: 'a', createdAt: 1 });
    const b = watch({ id: 'b', createdAt: 3 });
    const c = watch({ id: 'c', createdAt: 2, unseen: 2, lastChangedAt: 10 });
    expect(sortWatches([a, b, c]).map((w) => w.id)).toEqual(['c', 'b', 'a']);
    expect(totalUnseen([a, b, c])).toBe(2);
  });
});

describe('validation', () => {
  const base = { url: 'https://example.com/a#frag', name: '  My   page ', selectors: [], intervalMinutes: 15, mode: 'text', keyword: '', liveText: 'x' };

  it('accepts a good draft and cleans it', () => {
    const result = validateDraft(base);
    expect(result).toEqual({
      ok: true,
      value: { url: 'https://example.com/a', name: 'My page', selectors: [], intervalMinutes: 15, mode: 'text', keyword: '', liveText: 'x' },
    });
  });

  it('rejects bad input with a readable message', () => {
    expect(validateDraft({ ...base, url: 'chrome://settings' })).toMatchObject({ ok: false, message: expect.stringContaining('http') });
    expect(validateDraft({ ...base, intervalMinutes: 7 })).toMatchObject({ ok: false });
    expect(validateDraft({ ...base, mode: 'keyword', keyword: '  ' })).toMatchObject({ ok: false, message: 'Enter the keyword to look for.' });
    expect(validateDraft({ ...base, selectors: ['x'.repeat(2000)] })).toMatchObject({ ok: false });
    expect(validateDraft(null)).toMatchObject({ ok: false });
  });

  it('validates patches', () => {
    expect(validatePatch({ name: '' })).toMatchObject({ ok: false });
    expect(validatePatch({ intervalMinutes: 60, keyword: ' a  b ' })).toEqual({ ok: true, value: { intervalMinutes: 60, keyword: 'a b' } });
  });
});

describe('sanitizing stored data', () => {
  it('drops garbage and fills defaults', () => {
    expect(sanitizeWatches('nope')).toEqual([]);
    expect(sanitizeWatches([null, { id: 'x' }, { id: 'y', url: 'javascript:alert(1)' }])).toEqual([]);
    const restored = sanitizeWatch({ id: 'x', url: 'https://example.com', intervalMinutes: 999, mode: 'keyword', keyword: '', unseen: 50, status: 'weird' });
    expect(restored).toMatchObject({ name: 'example.com', intervalMinutes: 60, mode: 'text', unseen: MAX_CHANGES, status: 'pending', paused: false });
  });

  it('removes duplicate ids', () => {
    const one = { id: 'x', url: 'https://example.com' };
    expect(sanitizeWatches([one, one])).toHaveLength(1);
  });

  it('keeps a stored watch intact', () => {
    const original = watch({ error: { ...checkError('http', { status: 500 }), at: 5 }, errorCount: 2, lastSummary: 'x' });
    expect(sanitizeWatch(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });
});
