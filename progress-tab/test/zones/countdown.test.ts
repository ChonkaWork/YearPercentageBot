import { describe, expect, it } from 'vitest';
import { countdownState, countdownTarget, describeCountdown, sortCountdowns, type Countdown } from '../../src/core/countdown';
import { local } from './helpers';

function countdown(overrides: Partial<Countdown>): Countdown {
  return { id: 'id', name: 'Name', date: '2026-12-25', time: '18:00', createdAt: local(2026, 9, 1).getTime(), showProgress: true, repeat: 'none', ...overrides };
}

const at = local(2026, 9, 27, 12);
const view = (c: Countdown, now = at, hour12 = false) => describeCountdown(c, now, { hour12, decimals: 1 });

describe('countdownTarget', () => {
  it('uses local time; a date without time means the start of that day', () => {
    expect(countdownTarget({ date: '2026-12-25', time: '18:00' })?.getTime()).toBe(local(2026, 12, 25, 18).getTime());
    expect(countdownTarget({ date: '2026-12-25', time: null })?.getTime()).toBe(local(2026, 12, 25).getTime());
    expect(countdownTarget({ date: '2026-02-30', time: null })).toBeNull();
    expect(countdownTarget({ date: '2026-12-25', time: '25:00' })).toBeNull();
  });
});

describe('describeCountdown', () => {
  it('shows the time remaining', () => {
    expect(view(countdown({}))).toMatchObject({ state: 'upcoming', statusText: '89 days 6 h', targetText: 'Fri, Dec 25, 2026 · 18:00' });
    expect(view(countdown({}), at, true)?.targetText).toBe('Fri, Dec 25, 2026 · 6:00 PM');
    expect(view(countdown({ date: '2026-09-28', time: null }))).toMatchObject({ statusText: '12 h', targetText: 'Mon, Sep 28, 2026' });
    expect(view(countdown({ date: '2026-09-27', time: '12:00' }), local(2026, 9, 27, 11, 59, 59))?.statusText).toBe('1 s');
    expect(view(countdown({ date: '2026-09-27', time: '12:30' }))?.statusText).toBe('30 min');
    expect(view(countdown({ date: '2030-01-01', time: null }))?.statusText).toBe('1,191 days 12 h');
  });

  it('a date without a time is "Today" all day, then counts days since', () => {
    const today = countdown({ date: '2026-09-27', time: null });
    expect(view(today, local(2026, 9, 27, 0, 0))).toMatchObject({ state: 'today', statusText: 'Today' });
    expect(view(today, local(2026, 9, 27, 23, 59, 59))?.statusText).toBe('Today');
    expect(view(today, local(2026, 9, 28))).toMatchObject({ state: 'passed', statusText: 'passed 1 day ago' });
    expect(view(today, local(2026, 10, 7, 9))?.statusText).toBe('passed 10 days ago');
  });

  it('a timed countdown passes at its exact minute', () => {
    const lunch = countdown({ date: '2026-09-27', time: '12:00' });
    expect(view(lunch, at)).toMatchObject({ state: 'passed', statusText: 'passed just now' });
    expect(view(lunch, local(2026, 9, 27, 12, 0, 59))?.statusText).toBe('passed just now');
    expect(view(lunch, local(2026, 9, 27, 12, 5))?.statusText).toBe('passed 5 min ago');
    expect(view(lunch, local(2026, 9, 27, 15, 30))?.statusText).toBe('passed 3 h ago');
    expect(view(lunch, local(2026, 10, 4, 12, 0))?.statusText).toBe('passed 7 days ago');
    expect(view(countdown({ date: '1999-12-31', time: '23:59' }), at)?.statusText).toBe('passed 9,766 days ago');
  });

  it('measures progress from when it was added', () => {
    const c = countdown({ date: '2026-12-10', time: null, createdAt: local(2026, 11, 10).getTime() });
    expect(view(c, local(2026, 11, 25))?.progress?.text).toBe('50.0%');
    expect(view(c, local(2026, 11, 10))?.progress?.text).toBe('0.0%');
    expect(view(c, local(2026, 12, 9, 23, 59, 59))?.progress?.text).toBe('99.9%');
    // Once the date has come, the bar would only ever say 100%: it goes away.
    expect(view(c, local(2026, 12, 10))?.progress).toBeNull();
    expect(view(c, local(2027, 1, 10))?.fraction).toBeNull();
    expect(view({ ...c, showProgress: false }, local(2026, 11, 25))?.progress).toBeNull();
    // Added after the target: nothing to measure.
    expect(view({ ...c, createdAt: local(2026, 12, 11).getTime() }, local(2026, 12, 12))?.progress).toBeNull();
  });

  it('returns null for broken data', () => {
    expect(view(countdown({ date: 'soon' }))).toBeNull();
  });
});

describe('sortCountdowns', () => {
  it('puts today first, then the soonest upcoming, then the most recently passed', () => {
    const list = [
      countdown({ id: 'far', date: '2027-06-01', time: null }),
      countdown({ id: 'old', date: '2025-01-01', time: null }),
      countdown({ id: 'soon', date: '2026-10-01', time: '08:00' }),
      countdown({ id: 'today', date: '2026-09-27', time: null }),
      countdown({ id: 'recent', date: '2026-09-27', time: '09:00' }),
      countdown({ id: 'sooner', date: '2026-09-27', time: '18:00' }),
    ];
    expect(sortCountdowns(list, at).map((c) => c.id)).toEqual(['today', 'sooner', 'soon', 'far', 'recent', 'old']);
    expect(countdownState(list[3] as Countdown, at)).toBe('today');
  });

  it('breaks ties by name', () => {
    const list = [countdown({ id: 'b', name: 'Beta' }), countdown({ id: 'a', name: 'Alpha' })];
    expect(sortCountdowns(list, at).map((c) => c.id)).toEqual(['a', 'b']);
  });
});
