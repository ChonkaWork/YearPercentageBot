import { describe, expect, it } from 'vitest';
import type { Snippet } from '../src/core/snippets';
import { describeUsage, formatUsage, isSortOrder, recordUse, relativeTime, sanitizeUsage, sortByOrder } from '../src/core/usage';

const snippet = (id: string, abbreviation: string, updatedAt = 0): Snippet => ({ id, abbreviation, text: 'x', label: '', createdAt: 0, updatedAt });

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('sanitizeUsage', () => {
  it('keeps valid entries and drops the rest', () => {
    expect(sanitizeUsage(undefined)).toEqual({});
    expect(sanitizeUsage([1, 2])).toEqual({});
    expect(
      sanitizeUsage({
        a: { count: 3, lastUsed: 100 },
        b: { count: 0, lastUsed: 100 },
        c: { count: 1.5, lastUsed: 100 },
        d: { count: 2, lastUsed: -1 },
        e: { count: 2 },
        f: 'x',
        ['g'.repeat(65)]: { count: 1, lastUsed: 1 },
      }),
    ).toEqual({ a: { count: 3, lastUsed: 100 } });
  });
});

describe('recordUse', () => {
  it('counts and remembers the last use', () => {
    const once = recordUse({}, 'a', 1000);
    expect(once).toEqual({ a: { count: 1, lastUsed: 1000 } });
    expect(recordUse(once, 'a', 5000)).toEqual({ a: { count: 2, lastUsed: 5000 } });
    // A clock that went backwards never moves "last used" back.
    expect(recordUse({ a: { count: 1, lastUsed: 9000 } }, 'a', 5000)).toEqual({ a: { count: 2, lastUsed: 9000 } });
  });

  it('drops entries of deleted snippets', () => {
    const usage = { a: { count: 1, lastUsed: 1 }, gone: { count: 5, lastUsed: 1 } };
    expect(recordUse(usage, 'a', 2, new Set(['a', 'b']))).toEqual({ a: { count: 2, lastUsed: 2 } });
  });
});

describe('sortByOrder', () => {
  const list = [snippet('1', ';b', 10), snippet('2', ';a', 20), snippet('3', ';c', 30), snippet('4', ';d', 5)];
  const usage = { '1': { count: 5, lastUsed: 100 }, '3': { count: 5, lastUsed: 300 }, '4': { count: 1, lastUsed: 500 } };
  const order = (mode: 'used' | 'az' | 'recent') => sortByOrder(list, mode, usage).map((entry) => entry.abbreviation);

  it('sorts by use, alphabetically or by the last use', () => {
    expect(order('az')).toEqual([';a', ';b', ';c', ';d']);
    expect(order('used')).toEqual([';c', ';b', ';d', ';a']);
    expect(order('recent')).toEqual([';d', ';c', ';b', ';a']);
  });

  it('puts never-used snippets last in "recent", newest edits first', () => {
    const fresh = [snippet('x', ';x', 1), snippet('y', ';y', 2)];
    expect(sortByOrder(fresh, 'recent', {}).map((entry) => entry.abbreviation)).toEqual([';y', ';x']);
    expect(sortByOrder(fresh, 'used', {}).map((entry) => entry.abbreviation)).toEqual([';x', ';y']);
  });

  it('validates the stored order', () => {
    expect(isSortOrder('used')).toBe(true);
    expect(isSortOrder('random')).toBe(false);
  });
});

describe('usage text', () => {
  const now = 1_000 * DAY;
  it('says how long ago', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now + 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * MINUTE, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 60 * MINUTE, now)).toBe('3 h ago');
    expect(relativeTime(now - DAY, now)).toBe('yesterday');
    expect(relativeTime(now - 2 * DAY, now)).toBe('2 days ago');
    expect(relativeTime(now - 21 * DAY, now)).toBe('3 weeks ago');
    expect(relativeTime(now - 90 * DAY, now)).toBe('3 months ago');
    expect(relativeTime(now - 400 * DAY, now)).toBe('a year ago');
    expect(relativeTime(now - 800 * DAY, now)).toBe('2 years ago');
  });

  it('formats a row label and a longer description', () => {
    expect(formatUsage({ count: 34, lastUsed: now - 2 * DAY }, now)).toBe('used 34× · 2 days ago');
    expect(formatUsage({ count: 1234, lastUsed: now }, now)).toBe('used 1,234× · just now');
    expect(formatUsage(undefined, now)).toBe(null);
    expect(describeUsage({ count: 1, lastUsed: now - DAY }, now)).toBe('Used once, last yesterday');
    expect(describeUsage({ count: 34, lastUsed: now - 2 * DAY }, now)).toBe('Used 34 times, last 2 days ago');
    expect(describeUsage(undefined, now)).toBe('Not used yet');
  });
});
