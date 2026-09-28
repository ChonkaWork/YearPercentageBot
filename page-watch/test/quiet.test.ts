import { describe, expect, it } from 'vitest';
import {
  holdNotification,
  isQuietAt,
  MAX_HELD,
  minuteOfDay,
  minutesUntilQuietEnds,
  quietEndsAt,
  sanitizeHeld,
  summarizeHeld,
  type HeldNotification,
} from '../src/core/quiet';
import { formatClock, parseClock, sanitizeQuietHours, sanitizeSettings } from '../src/core/settings';

const at = (hours: number, minutes = 0) => hours * 60 + minutes;
const night = { enabled: true, start: at(22), end: at(7) };
const lunch = { enabled: true, start: at(12), end: at(13, 30) };

describe('quiet hours', () => {
  it('spans midnight when start is after end', () => {
    expect(isQuietAt(night, at(23))).toBe(true);
    expect(isQuietAt(night, at(0, 30))).toBe(true);
    expect(isQuietAt(night, at(6, 59))).toBe(true);
    expect(isQuietAt(night, at(7))).toBe(false);
    expect(isQuietAt(night, at(12))).toBe(false);
    expect(isQuietAt(night, at(22))).toBe(true);
  });

  it('works within a day', () => {
    expect(isQuietAt(lunch, at(12, 15))).toBe(true);
    expect(isQuietAt(lunch, at(13, 30))).toBe(false);
    expect(isQuietAt(lunch, at(11, 59))).toBe(false);
  });

  it('is never quiet when off or empty', () => {
    expect(isQuietAt({ ...night, enabled: false }, at(23))).toBe(false);
    expect(isQuietAt({ enabled: true, start: at(8), end: at(8) }, at(8))).toBe(false);
  });

  it('knows when quiet hours end', () => {
    expect(minutesUntilQuietEnds(night, at(23))).toBe(8 * 60);
    expect(minutesUntilQuietEnds(night, at(6, 30))).toBe(30);
    expect(minutesUntilQuietEnds(lunch, at(12))).toBe(90);
    const now = new Date(2026, 8, 28, 23, 15, 42);
    expect(minuteOfDay(now)).toBe(at(23, 15));
    expect(new Date(quietEndsAt(night, now))).toEqual(new Date(2026, 8, 29, 7, 0, 0));
  });
});

describe('quiet hours settings', () => {
  it('sanitizes (off by default, 22:00–07:00)', () => {
    expect(sanitizeSettings(undefined).quietHours).toEqual({ enabled: false, start: at(22), end: at(7) });
    expect(sanitizeQuietHours({ enabled: true, start: at(21, 30), end: 1440 })).toEqual({ enabled: true, start: at(21, 30), end: at(7) });
    expect(sanitizeQuietHours({ enabled: 'yes', start: 1.5, end: -1 })).toEqual({ enabled: false, start: at(22), end: at(7) });
  });

  it('parses and formats clock times', () => {
    expect(parseClock('22:00')).toBe(at(22));
    expect(parseClock('7:05')).toBe(at(7, 5));
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('12:60')).toBeNull();
    expect(parseClock('')).toBeNull();
    expect(formatClock(at(7, 5))).toBe('07:05');
    expect(formatClock(at(22))).toBe('22:00');
  });
});

describe('held notifications', () => {
  const change = (watchId: string, text: string, time: number): HeldNotification => ({ kind: 'change', watchId, name: watchId, text, at: time });
  const state = (id: string, unseen: number, hasError = false) => ({ id, name: `Watch ${id}`, unseen, hasError });

  it('keeps a bounded queue and sanitizes it', () => {
    let held: HeldNotification[] = [];
    for (let i = 0; i < MAX_HELD + 5; i++) held = holdNotification(held, change('a', `#${i}`, i));
    expect(held).toHaveLength(MAX_HELD);
    expect(held[0]!.text).toBe('#5');
    expect(sanitizeHeld([{ kind: 'change', watchId: 'a', name: 'A', text: 't', at: 1 }, { kind: 'x', watchId: 'b' }, 'junk', null])).toEqual([
      { kind: 'change', watchId: 'a', name: 'A', text: 't', at: 1 },
    ]);
    expect(sanitizeHeld('nope')).toEqual([]);
  });

  it('summarizes per watch, newest first', () => {
    const summary = summarizeHeld(
      [change('a', 'Price changed: $10 → $9', 1), change('b', '+2 lines', 2), change('a', 'Price changed: $9 → $8', 3)],
      [state('a', 2), state('b', 1)],
    )!;
    expect(summary.title).toBe('Page Watch: during quiet hours');
    expect(summary.message).toBe('3 changes on 2 watches');
    expect(summary.items).toEqual([
      { title: 'Watch a', message: 'Price changed: $9 → $8 (+1 more)' },
      { title: 'Watch b', message: '+2 lines' },
    ]);
  });

  it('includes problems that are still there', () => {
    const summary = summarizeHeld(
      [change('a', '+1 line', 1), { kind: 'error', watchId: 'b', name: 'b', text: 'Server error', at: 2 }],
      [state('a', 1), state('b', 0, true)],
    )!;
    expect(summary.message).toBe('1 change and 1 problem on 2 watches');
    expect(summary.items[0]).toEqual({ title: 'Watch b', message: 'Server error' });
  });

  it('leaves out what was already seen, fixed or deleted', () => {
    expect(
      summarizeHeld(
        [change('a', 'x', 1), change('gone', 'y', 2), { kind: 'error', watchId: 'b', name: 'b', text: 'e', at: 3 }],
        [state('a', 0), state('b', 0, false)],
      ),
    ).toBeNull();
    expect(summarizeHeld([], [])).toBeNull();
  });
});
