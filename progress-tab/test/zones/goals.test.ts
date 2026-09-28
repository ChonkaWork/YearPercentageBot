import { describe, expect, it } from 'vitest';
import { describeGoal, goalBounds, goalPace, periodDates, type Goal } from '../../src/core/goals';
import { fractionBetween, periodAt } from '../../src/core/time';
import { HOUR, fields, local, zone } from './helpers';

// Goal pace in every zone (see vitest.config.ts): periods are local calendar days, and pace is
// real elapsed time, so DST days count as 23 or 25 hours.

function goal(overrides: Partial<Goal> = {}): Goal {
  return { id: 'g', name: 'Read', unit: 'books', target: 24, count: 0, period: 'year', start: '2026-01-01', end: '2026-12-31', createdAt: 1, ...overrides };
}

const iso = (date: Date | undefined) => date?.toISOString();

describe('goal periods in every zone', () => {
  it('a year goal covers exactly the year row’s period', () => {
    const now = local(2026, 10, 16, 9, 41);
    const bounds = goalBounds(goal())!;
    const year = periodAt('year', now, 'monday');
    expect(bounds.start.getTime()).toBe(year.start.getTime());
    expect(bounds.end.getTime()).toBe(year.end.getTime());
    expect(goalPace(goal(), now)?.elapsed).toBe(fractionBetween(year.start, year.end, now));
  });

  it('month and quarter goals match the calendar, and pace is real elapsed time', () => {
    for (const month of [1, 3, 4, 9, 10, 11]) {
      const now = local(2026, month, 15, 12);
      const dates = periodDates('month', now);
      const bounds = goalBounds(dates)!;
      const row = periodAt('month', now, 'monday');
      expect(bounds.start.getTime(), dates.start).toBe(row.start.getTime());
      expect(bounds.end.getTime(), dates.end).toBe(row.end.getTime());
      const pace = goalPace(goal({ ...dates, period: 'month', target: 30 }), now)!;
      expect(pace.expected).toBeCloseTo((30 * (now.getTime() - row.start.getTime())) / (row.end.getTime() - row.start.getTime()), 9);
    }
    const q4 = goalBounds(periodDates('quarter', local(2026, 11, 20)))!;
    expect(fields(q4.start)).toBe(fields(periodAt('month', local(2026, 10, 1), 'monday').start));
    expect(q4.end.getTime()).toBe(periodAt('year', local(2026, 11, 20), 'monday').end.getTime());
  });

  it('is on pace at the start, and the target is expected only when the last day is over', () => {
    const g = goal({ period: 'month', start: '2026-03-01', end: '2026-03-31', target: 31 });
    const { start, end } = goalBounds(g)!;
    expect(goalPace(g, start)).toMatchObject({ elapsed: 0, expected: 0, status: 'on-pace' });
    expect(goalPace(g, new Date(end.getTime() - 1))?.elapsed).toBeLessThan(1);
    expect(goalPace({ ...g, count: 31 }, new Date(end.getTime() - 1))?.status).toBe('reached');
    expect(goalPace({ ...g, count: 30 }, end)).toMatchObject({ elapsed: 1, status: 'missed' });
    expect(describeGoal({ ...g, count: 30 }, end)?.verdict).toBe('ended 1 short');
  });

  it('a one-day custom period lasts the whole local day', () => {
    const g = goal({ period: 'custom', start: '2026-10-25', end: '2026-10-25', target: 10 });
    const bounds = goalBounds(g)!;
    const day = periodAt('day', local(2026, 10, 25, 12), 'monday');
    expect(bounds.start.getTime()).toBe(day.start.getTime());
    expect(bounds.end.getTime()).toBe(day.end.getTime());
  });
});

describe.runIf(zone === 'Europe/Kyiv')('Europe/Kyiv', () => {
  it('October 2026 is 31 days and 1 hour long, so mid-month pace counts the extra hour', () => {
    const g = goal({ period: 'month', start: '2026-10-01', end: '2026-10-31', target: 745 });
    const { start, end } = goalBounds(g)!;
    expect(iso(start)).toBe('2026-09-30T21:00:00.000Z');
    expect(iso(end)).toBe('2026-10-31T22:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(745 * HOUR);
    // One unit per real hour: after the 25-hour day, 26 days + 1 hour + 12 hours have passed.
    const pace = goalPace({ ...g, count: 637 }, local(2026, 10, 27, 12))!;
    expect(pace.expected).toBeCloseTo(26 * 24 + 1 + 12, 9);
    expect(pace.status).toBe('on-pace');
  });

  it('March 2026 is an hour short', () => {
    const { start, end } = goalBounds(goal({ start: '2026-03-01', end: '2026-03-31' }))!;
    expect(end.getTime() - start.getTime()).toBe(31 * 24 * HOUR - HOUR);
  });
});

describe.runIf(zone === 'America/Santiago')('America/Santiago', () => {
  it('a period starting on September 6, 2026 starts at 01:00 (midnight doesn’t exist)', () => {
    const g = goal({ period: 'custom', start: '2026-09-06', end: '2026-09-12', target: 7 });
    const { start } = goalBounds(g)!;
    expect(fields(start)).toBe('2026-09-06 01:00:00');
    expect(goalPace(g, local(2026, 9, 6, 0, 30))?.status).toBe('on-pace');
    expect(goalPace(g, new Date(start.getTime() - 1))?.status).toBe('upcoming');
  });
});

describe.runIf(zone === 'Australia/Lord_Howe')('Australia/Lord_Howe', () => {
  it('the week with the 23.5-hour day is 167.5 hours', () => {
    const { start, end } = goalBounds(goal({ period: 'custom', start: '2026-09-28', end: '2026-10-04' }))!;
    expect(end.getTime() - start.getTime()).toBe(167.5 * HOUR);
  });
});
