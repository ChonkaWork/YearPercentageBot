import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarDaysBetween,
  calendarDiff,
  dayLengthMs,
  dayOfYear,
  daysInMonth,
  daysInYear,
  floorToSecond,
  fractionBetween,
  isLeapYear,
  periodAt,
  startOfDay,
  startOfWeek,
  PERIOD_KINDS,
  WEEK_STARTS,
} from '../../src/core/time';
import { DAY, HOUR, fields, local, zone } from './helpers';

// Runs once per time zone (see vitest.config.ts). Everything here must hold in every zone.

describe(`time zone setup (${zone})`, () => {
  it('the worker really runs in the requested zone', () => {
    const offsets: Record<string, number> = {
      UTC: 0,
      'Europe/Kyiv': -120,
      'America/New_York': 300,
      'America/Santiago': 180,
      'Australia/Lord_Howe': -660,
      'Asia/Kolkata': -330,
    };
    const expected = offsets[zone];
    // Jan 15: standard time in the north, summer time in the south.
    if (expected !== undefined) expect(local(2026, 1, 15, 12).getTimezoneOffset()).toBe(expected);
  });
});

describe('calendar basics', () => {
  it('knows leap years', () => {
    expect([2024, 2025, 2026, 1900, 2000, 2100, 2400].map(isLeapYear)).toEqual([true, false, false, false, true, false, true]);
    expect(daysInYear(2024)).toBe(366);
    expect(daysInYear(2026)).toBe(365);
  });

  it('knows month lengths', () => {
    expect(daysInMonth(2024, 1)).toBe(29);
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(1900, 1)).toBe(28);
    expect(daysInMonth(2000, 1)).toBe(29);
    expect([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((m) => daysInMonth(2026, m))).toEqual([31, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });

  it('counts calendar days and days of the year', () => {
    expect(calendarDaysBetween(local(2026, 1, 1), local(2026, 12, 31, 23, 59))).toBe(364);
    expect(calendarDaysBetween(local(2026, 3, 1, 12), local(2026, 4, 1, 1))).toBe(31);
    expect(calendarDaysBetween(local(2026, 10, 1), local(2026, 11, 1))).toBe(31);
    expect(calendarDaysBetween(local(2026, 9, 28), local(2026, 9, 27))).toBe(-1);
    expect(dayOfYear(local(2026, 1, 1))).toBe(1);
    expect(dayOfYear(local(2026, 3, 1))).toBe(60);
    expect(dayOfYear(local(2024, 3, 1))).toBe(61);
    expect(dayOfYear(local(2026, 9, 27, 12))).toBe(270);
    expect(dayOfYear(local(2026, 12, 31, 23, 59, 59))).toBe(365);
    expect(dayOfYear(local(2024, 12, 31))).toBe(366);
  });
});

describe('period boundaries', () => {
  const now = local(2026, 9, 27, 12); // a Sunday

  it('year, month and day start at local midnight', () => {
    expect(fields(periodAt('year', now, 'monday').start)).toBe('2026-01-01 00:00:00');
    expect(fields(periodAt('year', now, 'monday').end)).toBe('2027-01-01 00:00:00');
    expect(fields(periodAt('month', now, 'monday').start)).toBe('2026-09-01 00:00:00');
    expect(fields(periodAt('month', now, 'monday').end)).toBe('2026-10-01 00:00:00');
    expect(fields(periodAt('day', now, 'monday').start)).toBe('2026-09-27 00:00:00');
    expect(fields(periodAt('day', now, 'monday').end)).toBe('2026-09-28 00:00:00');
  });

  it('December rolls over into the next year; February follows leap years', () => {
    expect(fields(periodAt('month', local(2026, 12, 15), 'monday').end)).toBe('2027-01-01 00:00:00');
    expect(fields(periodAt('month', local(2024, 2, 10), 'monday').end)).toBe('2024-03-01 00:00:00');
    expect(fields(periodAt('month', local(2026, 2, 10), 'monday').end)).toBe('2026-03-01 00:00:00');
  });

  it('weeks start on Monday or Sunday', () => {
    expect(fields(periodAt('week', now, 'monday').start)).toBe('2026-09-21 00:00:00');
    expect(fields(periodAt('week', now, 'monday').end)).toBe('2026-09-28 00:00:00');
    expect(fields(periodAt('week', now, 'sunday').start)).toBe('2026-09-27 00:00:00');
    expect(fields(periodAt('week', now, 'sunday').end)).toBe('2026-10-04 00:00:00');
    // Saturday night belongs to the Sunday-started week that began 6 days earlier.
    expect(fields(startOfWeek(local(2026, 10, 3, 23, 59, 59), 'sunday'))).toBe('2026-09-27 00:00:00');
    // Monday 00:00 starts a new Monday week.
    expect(fields(startOfWeek(local(2026, 9, 28), 'monday'))).toBe('2026-09-28 00:00:00');
    expect(fields(startOfWeek(local(2026, 9, 28), 'sunday'))).toBe('2026-09-27 00:00:00');
  });

  it('weeks can span two years', () => {
    // Jan 1, 2026 is a Thursday.
    expect(fields(periodAt('week', local(2026, 1, 1, 9), 'monday').start)).toBe('2025-12-29 00:00:00');
    expect(fields(periodAt('week', local(2026, 1, 1, 9), 'sunday').start)).toBe('2025-12-28 00:00:00');
    expect(fields(periodAt('week', local(2026, 1, 1, 9), 'sunday').end)).toBe('2026-01-04 00:00:00');
  });

  it('exact midnight belongs to the new period', () => {
    const newYear = local(2027, 1, 1);
    const year = periodAt('year', newYear, 'monday');
    expect(year.start.getTime()).toBe(newYear.getTime());
    expect(fractionBetween(year.start, year.end, newYear)).toBe(0);
    expect(periodAt('day', newYear, 'monday').start.getTime()).toBe(newYear.getTime());
    expect(periodAt('month', newYear, 'monday').start.getTime()).toBe(newYear.getTime());
  });

  it('the last millisecond of the year still belongs to it', () => {
    const last = local(2026, 12, 31, 23, 59, 59, 999);
    const year = periodAt('year', last, 'monday');
    expect(year.start.getFullYear()).toBe(2026);
    const fraction = fractionBetween(year.start, year.end, last);
    expect(fraction).toBeLessThan(1);
    expect(fraction).toBeGreaterThan(0.99999999);
  });
});

describe('fractionBetween', () => {
  it('is 0 at the start, clamps outside and handles empty ranges', () => {
    expect(fractionBetween(0, 100, 0)).toBe(0);
    expect(fractionBetween(0, 100, 25)).toBe(0.25);
    expect(fractionBetween(0, 100, -5)).toBe(0);
    expect(fractionBetween(0, 100, 150)).toBe(1);
    expect(fractionBetween(100, 100, 100)).toBe(1);
    expect(fractionBetween(100, 50, 60)).toBe(1);
    expect(fractionBetween(100, 50, 40)).toBe(0);
    expect(fractionBetween(0, 100, Number.NaN)).toBe(0);
  });
});

describe('calendarDiff', () => {
  it('counts calendar days, then hours, minutes and seconds', () => {
    expect(calendarDiff(local(2026, 9, 27, 12), local(2027, 1, 1))).toEqual({ days: 95, hours: 12, minutes: 0, seconds: 0 });
    expect(calendarDiff(local(2026, 9, 27, 12), local(2026, 12, 25, 18))).toEqual({ days: 89, hours: 6, minutes: 0, seconds: 0 });
    expect(calendarDiff(local(2026, 12, 31, 23, 59, 59), local(2027, 1, 1))).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 1 });
    expect(calendarDiff(local(2026, 9, 27, 10, 15, 30), local(2026, 9, 27, 12, 0, 0))).toEqual({ days: 0, hours: 1, minutes: 44, seconds: 30 });
  });

  it('is zero when the target is not in the future', () => {
    const now = local(2026, 9, 27, 12);
    expect(calendarDiff(now, now)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
    expect(calendarDiff(now, local(2026, 9, 26))).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  });

  it('crosses leap days and month ends', () => {
    expect(calendarDiff(local(2024, 2, 28, 12), local(2024, 3, 1, 12)).days).toBe(2);
    expect(calendarDiff(local(2026, 2, 28, 12), local(2026, 3, 1, 12)).days).toBe(1);
    expect(calendarDiff(local(2024, 1, 1), local(2025, 1, 1)).days).toBe(366);
  });
});

describe('invariants over whole years, in every zone', () => {
  for (const year of [2024, 2026]) {
    it(`${year}: days are contiguous, 22-26 h long and add up to the year`, () => {
      const yearPeriod = periodAt('year', local(year, 6, 1), 'monday');
      let cursor = yearPeriod.start.getTime();
      let total = 0;
      for (let day = 0; day < daysInYear(year); day++) {
        const noon = local(year, 1, 1 + day, 12);
        const period = periodAt('day', noon, 'monday');
        expect(period.start.getTime(), `start of ${fields(noon)}`).toBe(cursor);
        expect(period.start.getDate()).toBe(noon.getDate());
        const length = period.end.getTime() - period.start.getTime();
        expect(length).toBeGreaterThanOrEqual(22 * HOUR);
        expect(length).toBeLessThanOrEqual(26 * HOUR);
        expect(dayLengthMs(noon)).toBe(length);
        total += length;
        cursor = period.end.getTime();
      }
      expect(cursor).toBe(yearPeriod.end.getTime());
      expect(total).toBe(yearPeriod.end.getTime() - yearPeriod.start.getTime());
    });

    it(`${year}: months and weeks are contiguous`, () => {
      for (let month = 1; month <= 12; month++) {
        const period = periodAt('month', local(year, month, 15), 'monday');
        const next = periodAt('month', local(year, month + 1, 15), 'monday');
        expect(period.end.getTime()).toBe(next.start.getTime());
      }
      for (const weekStart of WEEK_STARTS) {
        let week = periodAt('week', local(year, 1, 1, 12), weekStart);
        for (let i = 0; i < 53; i++) {
          const next = periodAt('week', new Date(week.end.getTime() + 12 * HOUR), weekStart);
          expect(next.start.getTime()).toBe(week.end.getTime());
          expect(week.start.getDay()).toBe(weekStart === 'monday' ? 1 : 0);
          expect(calendarDaysBetween(week.start, week.end)).toBe(7);
          week = next;
        }
      }
    });

    it(`${year}: progress only goes up, and remaining time lands exactly on the end`, () => {
      const start = local(year, 1, 1).getTime();
      const last: Record<string, number> = {};
      for (let t = start; t < start + 366 * DAY; t += 7 * HOUR + 13 * 60_000 + 7_000) {
        const now = new Date(t);
        for (const kind of PERIOD_KINDS) {
          const period = periodAt(kind, now, 'monday');
          expect(period.start.getTime()).toBeLessThanOrEqual(t);
          expect(period.end.getTime()).toBeGreaterThan(t);
          const fraction = fractionBetween(period.start, period.end, now);
          const key = `${kind}:${period.start.getTime()}`;
          expect(fraction).toBeGreaterThanOrEqual(last[key] ?? 0);
          expect(fraction).toBeLessThan(1);
          last[key] = fraction;

          const left = calendarDiff(now, period.end);
          // Day 0 is `now` itself: rebuilding it from its fields is ambiguous in a repeated DST hour.
          const base = left.days === 0 ? t : addDays(now, left.days).getTime();
          const landed = base + ((left.hours * 60 + left.minutes) * 60 + left.seconds) * 1000;
          // addDays can be pushed forward by a DST gap; the rest still adds up exactly.
          if (left.days === 0) expect(landed).toBe(period.end.getTime());
          else expect(Math.abs(landed - period.end.getTime())).toBeLessThanOrEqual(HOUR);
        }
      }
    });
  }
});

describe('helpers', () => {
  it('startOfDay and addDays keep local wall-clock time', () => {
    expect(fields(startOfDay(local(2026, 9, 27, 18, 30)))).toBe('2026-09-27 00:00:00');
    expect(fields(addDays(local(2026, 9, 27, 18, 30), 5))).toBe('2026-10-02 18:30:00');
    expect(fields(addDays(local(2026, 1, 1, 8), -1))).toBe('2025-12-31 08:00:00');
  });

  it('floorToSecond drops milliseconds', () => {
    expect(floorToSecond(1_700_000_000_999).getTime()).toBe(1_700_000_000_000);
    expect(floorToSecond(new Date(1_700_000_000_000)).getTime()).toBe(1_700_000_000_000);
  });
});
