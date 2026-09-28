import { describe, expect, it } from 'vitest';
import { countdownTarget, describeCountdown } from '../../src/core/countdown';
import { describePeriod } from '../../src/core/periods';
import { addDays, calendarDiff, dayLengthMs, fractionBetween, periodAt } from '../../src/core/time';
import { HOUR, fields, local, zone } from './helpers';

// Zone-specific expectations, checked against absolute UTC instants. Each block runs only in its
// zone's project (see vitest.config.ts).

const iso = (date: Date | null) => date?.toISOString();
const opts = { weekStart: 'monday' as const, decimals: 1 };

describe.runIf(zone === 'Europe/Kyiv')('Europe/Kyiv', () => {
  it('March 29, 2026 is 23 hours long (03:00 -> 04:00)', () => {
    const noon = local(2026, 3, 29, 12);
    const day = periodAt('day', noon, 'monday');
    expect(iso(day.start)).toBe('2026-03-28T22:00:00.000Z');
    expect(iso(day.end)).toBe('2026-03-29T21:00:00.000Z');
    expect(dayLengthMs(noon)).toBe(23 * HOUR);
    const view = describePeriod('day', noon, opts);
    expect(view.fraction).toBeCloseTo(11 / 23, 12);
    expect(view.percent.text).toBe('47.8%');
    expect(view.caption).toBe('Sunday · 23-hour day, clocks go forward');
    expect(view.remainingText).toBe('12 h left');
    // Before the jump, the real time left is 20.5 h, not 21.5 h.
    expect(describePeriod('day', local(2026, 3, 29, 2, 30), opts).remainingText).toBe('20 h 30 min left');
  });

  it('October 25, 2026 is 25 hours long (04:00 -> 03:00)', () => {
    const noon = local(2026, 10, 25, 12);
    expect(dayLengthMs(noon)).toBe(25 * HOUR);
    const view = describePeriod('day', noon, opts);
    expect(view.fraction).toBe(13 / 25);
    expect(view.percent.text).toBe('52.0%');
    expect(view.caption).toBe('Sunday · 25-hour day, clocks go back');
    // Right after midnight there are more than 24 real hours left.
    expect(describePeriod('day', local(2026, 10, 25, 0, 30), opts).remainingText).toBe('24 h 30 min left');
  });

  it('the week and month containing a DST change are an hour shorter or longer', () => {
    const march = periodAt('week', local(2026, 3, 29, 12), 'monday');
    expect(march.end.getTime() - march.start.getTime()).toBe(7 * 24 * HOUR - HOUR);
    const october = periodAt('month', local(2026, 10, 10), 'monday');
    expect(october.end.getTime() - october.start.getTime()).toBe(31 * 24 * HOUR + HOUR);
  });

  it('year progress uses real elapsed time', () => {
    const now = local(2026, 9, 27, 12); // EEST, UTC+3
    expect(iso(now)).toBe('2026-09-27T09:00:00.000Z');
    const year = periodAt('year', now, 'monday');
    expect(iso(year.start)).toBe('2025-12-31T22:00:00.000Z');
    expect(iso(year.end)).toBe('2026-12-31T22:00:00.000Z');
    const expected = (Date.UTC(2026, 8, 27, 9) - Date.UTC(2025, 11, 31, 22)) / (Date.UTC(2026, 11, 31, 22) - Date.UTC(2025, 11, 31, 22));
    expect(fractionBetween(year.start, year.end, now)).toBe(expected);
    // The calendar part of "left" is not affected by the October change.
    expect(describePeriod('year', now, { ...opts, decimals: 2 }).remainingText).toBe('95 days 12 h left');
  });

  it('countdown times in the gap move forward; repeated times take the first occurrence', () => {
    expect(iso(countdownTarget({ date: '2026-03-29', time: '03:30' }))).toBe('2026-03-29T01:30:00.000Z'); // = 04:30 EEST
    expect(iso(countdownTarget({ date: '2026-10-25', time: '03:30' }))).toBe('2026-10-25T00:30:00.000Z'); // first 03:30 (EEST)
    expect(fields(addDays(local(2026, 3, 28, 3, 30), 1))).toBe('2026-03-29 04:30:00');
  });

  it('whole days across a DST change are calendar days', () => {
    expect(calendarDiff(local(2026, 10, 24, 12), local(2026, 10, 25, 12))).toEqual({ days: 1, hours: 0, minutes: 0, seconds: 0 });
    expect(calendarDiff(local(2026, 3, 28, 12), local(2026, 3, 29, 12))).toEqual({ days: 1, hours: 0, minutes: 0, seconds: 0 });
    // 24.5 real hours but less than one calendar day.
    expect(calendarDiff(local(2026, 10, 24, 12, 30), local(2026, 10, 25, 12))).toEqual({ days: 0, hours: 24, minutes: 30, seconds: 0 });
    const countdown = { id: 'a', name: 'Trip', date: '2026-11-01', time: '09:00', createdAt: 0, showProgress: false, repeat: 'none' as const };
    expect(describeCountdown(countdown, local(2026, 10, 20, 9), { hour12: false, decimals: 1 })?.statusText).toBe('12 days');
  });
});

describe.runIf(zone === 'America/New_York')('America/New_York', () => {
  it('March 8 and November 1, 2026 are 23 and 25 hours long', () => {
    const march = periodAt('day', local(2026, 3, 8, 12), 'monday');
    expect(iso(march.start)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(march.end)).toBe('2026-03-09T04:00:00.000Z');
    expect(dayLengthMs(local(2026, 11, 1, 12))).toBe(25 * HOUR);
    expect(describePeriod('day', local(2026, 11, 1, 12), opts).caption).toBe('Sunday · 25-hour day, clocks go back');
  });

  it('a Sunday-start week that begins on the DST day is 167 hours', () => {
    const week = periodAt('week', local(2026, 3, 10), 'sunday');
    expect(fields(week.start)).toBe('2026-03-08 00:00:00');
    expect(week.end.getTime() - week.start.getTime()).toBe(167 * HOUR);
  });

  it('countdown at 02:30 on March 8 (does not exist) and 01:30 on November 1 (twice)', () => {
    expect(iso(countdownTarget({ date: '2026-03-08', time: '02:30' }))).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
    expect(iso(countdownTarget({ date: '2026-11-01', time: '01:30' }))).toBe('2026-11-01T05:30:00.000Z'); // first, EDT
  });

  it('calendarDiff starting inside the repeated hour counts from the real instant', () => {
    const second = new Date(Date.UTC(2026, 10, 1, 6, 30)); // 01:30 EST, the second 01:30
    expect(second.getHours()).toBe(1);
    expect(calendarDiff(second, local(2026, 11, 1, 3))).toEqual({ days: 0, hours: 1, minutes: 30, seconds: 0 });
  });
});

describe.runIf(zone === 'America/Santiago')('America/Santiago', () => {
  it('September 6, 2026 starts at 01:00 because midnight does not exist', () => {
    const noon = local(2026, 9, 6, 12);
    const day = periodAt('day', noon, 'monday');
    expect(fields(day.start)).toBe('2026-09-06 01:00:00');
    expect(iso(day.start)).toBe('2026-09-06T04:00:00.000Z');
    expect(dayLengthMs(noon)).toBe(23 * HOUR);
    // The previous day ends exactly where this one starts.
    expect(periodAt('day', local(2026, 9, 5, 12), 'monday').end.getTime()).toBe(day.start.getTime());
    const view = describePeriod('day', noon, opts);
    expect(view.fraction).toBeCloseTo(11 / 23, 12);
    expect(view.caption).toBe('Sunday · 23-hour day, clocks go forward');
    // A Sunday-start week also starts at 01:00 that day.
    expect(fields(periodAt('week', noon, 'sunday').start)).toBe('2026-09-06 01:00:00');
    // A date-only countdown for that day starts at 01:00 too.
    expect(fields(countdownTarget({ date: '2026-09-06', time: null }) as Date)).toBe('2026-09-06 01:00:00');
  });

  it('April 4, 2026 is 25 hours long', () => {
    expect(dayLengthMs(local(2026, 4, 4, 12))).toBe(25 * HOUR);
    expect(iso(periodAt('day', local(2026, 4, 5, 12), 'monday').start)).toBe('2026-04-05T04:00:00.000Z');
  });
});

describe.runIf(zone === 'Australia/Lord_Howe')('Australia/Lord_Howe', () => {
  it('has half-hour DST changes', () => {
    expect(dayLengthMs(local(2026, 10, 4, 12))).toBe(23.5 * HOUR);
    expect(dayLengthMs(local(2026, 4, 5, 12))).toBe(24.5 * HOUR);
    expect(describePeriod('day', local(2026, 10, 4, 12), opts).caption).toBe('Sunday · 23.5-hour day, clocks go forward');
    expect(describePeriod('day', local(2026, 4, 5, 12), opts).caption).toBe('Sunday · 24.5-hour day, clocks go back');
  });
});

describe.runIf(zone === 'Asia/Kolkata')('Asia/Kolkata', () => {
  it('uses the +05:30 offset and has no DST', () => {
    expect(iso(periodAt('year', local(2026, 6, 1), 'monday').start)).toBe('2025-12-31T18:30:00.000Z');
    const year = periodAt('year', local(2026, 6, 1), 'monday');
    expect(year.end.getTime() - year.start.getTime()).toBe(365 * 24 * HOUR);
  });
});

describe.runIf(zone === 'UTC')('UTC', () => {
  it('gives exact textbook values', () => {
    const now = local(2026, 9, 27, 12);
    expect(describePeriod('year', now, { ...opts, decimals: 2 }).percent.text).toBe('73.83%');
    expect(describePeriod('month', now, opts).percent.text).toBe('88.3%');
    expect(describePeriod('week', now, opts).percent.text).toBe('92.8%');
    expect(describePeriod('week', now, { ...opts, weekStart: 'sunday' }).percent.text).toBe('7.1%');
    expect(describePeriod('day', now, opts).percent.text).toBe('50.0%');
  });
});
