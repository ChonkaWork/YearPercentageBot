import { describe, expect, it } from 'vitest';
import {
  countdownState,
  currentOccurrence,
  describeCountdown,
  occurrenceDate,
  sanitizeCountdowns,
  sortCountdowns,
  validateDraft,
  type Countdown,
} from '../../src/core/countdown';
import { HOUR, fields, local, zone } from './helpers';

// Repeating countdowns (birthdays, rent) in every zone: they roll over to the next date instead
// of passing.

function countdown(overrides: Partial<Countdown>): Countdown {
  return { id: 'id', name: 'Name', date: '2026-10-28', time: null, createdAt: local(2026, 1, 1).getTime(), showProgress: true, repeat: 'yearly', ...overrides };
}

const view = (c: Countdown, now: Date) => describeCountdown(c, now, { hour12: false, decimals: 1 });
const next = (c: Countdown, now: Date) => fields(currentOccurrence(c, now)!.target);

describe('occurrenceDate', () => {
  it('yearly: Feb 29 is Feb 28 in other years, and Feb 29 again in leap years', () => {
    const leap = { year: 2024, month: 2, day: 29 };
    expect([0, 1, 2, 3, 4, 5].map((n) => occurrenceDate(leap, 'yearly', n))).toEqual([
      { year: 2024, month: 2, day: 29 },
      { year: 2025, month: 2, day: 28 },
      { year: 2026, month: 2, day: 28 },
      { year: 2027, month: 2, day: 28 },
      { year: 2028, month: 2, day: 29 },
      { year: 2029, month: 2, day: 28 },
    ]);
    // 2100 is not a leap year.
    expect(occurrenceDate(leap, 'yearly', 76)).toEqual({ year: 2100, month: 2, day: 28 });
  });

  it('monthly: the day is clamped to short months but always measured from the stored day', () => {
    const rent = { year: 2026, month: 1, day: 31 };
    expect([0, 1, 2, 3, 4, 11, 12, 13].map((n) => occurrenceDate(rent, 'monthly', n))).toEqual([
      { year: 2026, month: 1, day: 31 },
      { year: 2026, month: 2, day: 28 },
      { year: 2026, month: 3, day: 31 },
      { year: 2026, month: 4, day: 30 },
      { year: 2026, month: 5, day: 31 },
      { year: 2026, month: 12, day: 31 },
      { year: 2027, month: 1, day: 31 },
      { year: 2027, month: 2, day: 28 },
    ]);
    expect(occurrenceDate({ year: 2027, month: 12, day: 30 }, 'monthly', 2)).toEqual({ year: 2028, month: 2, day: 29 });
    expect(occurrenceDate(rent, 'none', 5)).toEqual(rent);
  });
});

describe('rolling over', () => {
  it('a birthday in the past counts to its next date; on the day it reads "Today"', () => {
    const birthday = countdown({ date: '1990-10-28' });
    const now = local(2026, 10, 17, 12);
    expect(next(birthday, now)).toBe('2026-10-28 00:00:00');
    expect(view(birthday, now)).toMatchObject({
      state: 'upcoming',
      statusText: '10 days 12 h',
      statusShort: '10 d 12 h',
      targetText: 'Wed, Oct 28, 2026',
      repeatText: 'every year',
    });
    expect(view(birthday, local(2026, 10, 28, 0))).toMatchObject({ state: 'today', statusText: 'Today', targetText: 'Wed, Oct 28, 2026' });
    expect(view(birthday, local(2026, 10, 28, 23, 59, 59))?.state).toBe('today');
    // The next day it has rolled over to next year: never "passed".
    expect(view(birthday, local(2026, 10, 29, 0))).toMatchObject({ state: 'upcoming', targetText: 'Thu, Oct 28, 2027' });
    expect(countdownState(birthday, local(2026, 10, 29, 0))).toBe('upcoming');
  });

  it('a timed one rolls over at its exact minute', () => {
    const rent = countdown({ date: '2026-01-01', time: '09:00', repeat: 'monthly' });
    expect(next(rent, local(2026, 10, 1, 8, 59, 59))).toBe('2026-10-01 09:00:00');
    expect(view(rent, local(2026, 10, 1, 8, 59, 59))?.statusText).toBe('1 s');
    expect(next(rent, local(2026, 10, 1, 9))).toBe('2026-11-01 09:00:00');
    expect(view(rent, local(2026, 10, 1, 9))?.state).toBe('upcoming');
    // Eleven days before the next one.
    expect(view(rent, local(2026, 10, 21, 9))?.statusText).toBe('11 days');
  });

  it('Feb 29 birthdays fall on Feb 28 in 2027', () => {
    const leapling = countdown({ date: '2000-02-29' });
    expect(next(leapling, local(2026, 10, 17))).toBe('2027-02-28 00:00:00');
    expect(view(leapling, local(2027, 2, 28, 9))?.state).toBe('today');
    expect(next(leapling, local(2027, 3, 1))).toBe('2028-02-29 00:00:00');
  });

  it('a monthly 31st: Feb 28, then Mar 31 (not Mar 28)', () => {
    const payday = countdown({ date: '2026-01-31', repeat: 'monthly' });
    expect(next(payday, local(2026, 2, 1))).toBe('2026-02-28 00:00:00');
    expect(next(payday, local(2026, 3, 1))).toBe('2026-03-31 00:00:00');
    expect(next(payday, local(2026, 4, 1))).toBe('2026-04-30 00:00:00');
    expect(view(payday, local(2026, 4, 19, 12))?.statusText).toBe('10 days 12 h');
  });

  it('a first date in the future is just a countdown until then', () => {
    const later = countdown({ date: '2027-03-15', repeat: 'monthly' });
    expect(currentOccurrence(later, local(2026, 10, 17))).toMatchObject({ index: 0, previousOver: null });
    expect(next(later, local(2026, 10, 17))).toBe('2027-03-15 00:00:00');
  });

  it('finds the next date quickly even centuries later', () => {
    const old = countdown({ date: '1066-10-14', repeat: 'monthly' });
    const started = performance.now();
    expect(next(old, local(2026, 10, 17))).toBe('2026-11-14 00:00:00');
    expect(currentOccurrence(old, local(2026, 10, 17))?.index).toBe(960 * 12 + 1);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('the bar measures from the previous date (or from when it was added, if later)', () => {
    const rent = countdown({ date: '2026-01-01', repeat: 'monthly', createdAt: local(2026, 1, 1).getTime() });
    // Oct 16 noon, between Oct 1 (over at the end of that day) and Nov 1.
    const now = local(2026, 10, 16, 12);
    const previous = local(2026, 10, 2);
    const target = local(2026, 11, 1);
    expect(view(rent, now)?.fraction).toBeCloseTo((now.getTime() - previous.getTime()) / (target.getTime() - previous.getTime()), 12);
    const added = local(2026, 10, 10).getTime();
    expect(view({ ...rent, createdAt: added }, now)?.fraction).toBeCloseTo((now.getTime() - added) / (target.getTime() - added), 12);
    expect(view({ ...rent, showProgress: false }, now)?.fraction).toBeNull();
  });

  it('sorts by the next date, and a one-off one still passes', () => {
    const now = local(2026, 10, 17, 12);
    const list = [
      countdown({ id: 'one-off', date: '2026-10-01', repeat: 'none' }),
      countdown({ id: 'birthday', date: '1990-10-28' }),
      countdown({ id: 'rent', date: '2026-01-01', repeat: 'monthly' }),
      countdown({ id: 'trip', date: '2026-10-20', repeat: 'none' }),
    ];
    expect(sortCountdowns(list, now).map((c) => c.id)).toEqual(['trip', 'birthday', 'rent', 'one-off']);
    expect(view(list[0]!, now)?.state).toBe('passed');
  });

  it('is saved and validated like any other field', () => {
    expect(validateDraft({ name: 'Rent', date: '2026-01-31', time: '', showProgress: true, repeat: 'monthly' })).toMatchObject({ ok: true, value: { repeat: 'monthly' } });
    expect(validateDraft({ name: 'Rent', date: '2026-01-31', time: '', showProgress: true, repeat: 'weekly' })).toMatchObject({ ok: true, value: { repeat: 'none' } });
    const [kept, unknown, missing] = sanitizeCountdowns(
      [countdown({ id: 'a', repeat: 'monthly' }), { ...countdown({ id: 'b' }), repeat: 'daily' }, { ...countdown({ id: 'c' }), repeat: undefined }],
      1,
    );
    expect([kept?.repeat, unknown?.repeat, missing?.repeat]).toEqual(['monthly', 'none', 'none']);
  });
});

describe.runIf(zone === 'Europe/Kyiv')('Europe/Kyiv', () => {
  it('a monthly 03:30 on the day the clocks go back is the first 03:30, then rolls on', () => {
    const c = countdown({ date: '2026-09-25', time: '03:30', repeat: 'monthly' });
    const october = currentOccurrence(c, local(2026, 10, 20))!;
    expect(october.target.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    // After it, November 25 03:30 EET; between the two, 31 days and 1 hour pass.
    const november = currentOccurrence(c, new Date(october.target.getTime() + 1000))!;
    expect(november.target.toISOString()).toBe('2026-11-25T01:30:00.000Z');
    expect(november.target.getTime() - october.target.getTime()).toBe(31 * 24 * HOUR + HOUR);
  });
});

describe.runIf(zone === 'America/Santiago')('America/Santiago', () => {
  it('a date-only yearly countdown on September 6 starts at 01:00', () => {
    expect(next(countdown({ date: '2020-09-06' }), local(2026, 9, 1))).toBe('2026-09-06 01:00:00');
  });
});
