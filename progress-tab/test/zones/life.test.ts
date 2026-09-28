import { describe, expect, it } from 'vitest';
import { describeLife, WEEKS_PER_YEAR } from '../../src/core/life';
import { DAY, local } from './helpers';

/** Whole days between two local dates, independent of the code under test. */
function days(from: Date, to: Date): number {
  return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / DAY);
}

describe('describeLife', () => {
  const life = { birthDate: '1990-05-01', years: 80 };

  it('places this week in the grid: one column per year of age, 52 squares each', () => {
    const now = local(2026, 10, 16, 9, 41);
    const view = describeLife(life, now, 2)!;
    expect(view).toMatchObject({ state: 'living', columns: 80, rows: WEEKS_PER_YEAR, age: 36, weekOfYear: 25, filled: 36 * 52 + 24, current: 36 * 52 + 24 });
    expect(view.weeksLived).toBe(Math.floor(days(local(1990, 5, 1), now) / 7));
    expect(view.weeksTotal).toBe(Math.floor(days(local(1990, 5, 1), local(2070, 5, 1)) / 7));
    expect(view.weeksLeft).toBe(view.weeksTotal - view.weeksLived);
    const fraction = (now.getTime() - local(1990, 5, 1).getTime()) / (local(2070, 5, 1).getTime() - local(1990, 5, 1).getTime());
    expect(view.fraction).toBeCloseTo(fraction, 12);
    expect(view.percent.text).toBe(`${(Math.floor(fraction * 10_000) / 100).toFixed(2)}%`);
  });

  it('starts a new column on the birthday, and the 52nd square holds the last day or two', () => {
    expect(describeLife(life, local(2026, 5, 1), 2)).toMatchObject({ age: 36, weekOfYear: 1, current: 36 * 52 });
    expect(describeLife(life, local(2026, 4, 30, 23, 59, 59), 2)).toMatchObject({ age: 35, weekOfYear: 52, current: 35 * 52 + 51 });
    expect(describeLife(life, local(2026, 4, 29), 2)).toMatchObject({ age: 35, weekOfYear: 52 });
    expect(describeLife(life, local(1990, 5, 1), 2)).toMatchObject({ age: 0, weekOfYear: 1, filled: 0, current: 0 });
  });

  it('handles a Feb 29 birthday (celebrated on Mar 1 in other years)', () => {
    const leap = { birthDate: '2000-02-29', years: 80 };
    expect(describeLife(leap, local(2027, 2, 28, 12), 2)).toMatchObject({ age: 26, weekOfYear: 52 });
    expect(describeLife(leap, local(2027, 3, 1), 2)).toMatchObject({ age: 27, weekOfYear: 1 });
    expect(describeLife(leap, local(2028, 2, 29), 2)).toMatchObject({ age: 28, weekOfYear: 1 });
  });

  it('before birth and after the span', () => {
    expect(describeLife(life, local(1990, 4, 30, 23), 2)).toMatchObject({ state: 'unborn', filled: 0, current: null, weeksLived: 0, percent: { text: '0.00%' } });
    const past = describeLife({ birthDate: '1930-01-01', years: 80 }, local(2026, 10, 16), 2)!;
    expect(past).toMatchObject({ state: 'past', filled: 80 * 52, current: null, weeksLeft: 0, percent: { text: '100.00%' } });
    expect(past.summary).toBe(`${past.weeksLived.toLocaleString('en-US')} weeks lived, past the 80-year span you set.`);
    // The last second of the span is still inside it.
    expect(describeLife({ birthDate: '1946-10-16', years: 80 }, local(2026, 10, 15, 23, 59, 59), 2)).toMatchObject({ state: 'living', weekOfYear: 52, current: 79 * 52 + 51 });
    expect(describeLife({ birthDate: '1946-10-16', years: 80 }, local(2026, 10, 16), 2)?.state).toBe('past');
  });

  it('fills one square per week, never skipping or going back, through every DST change of two years', () => {
    let previous = describeLife(life, local(2025, 12, 31, 12), 2)!;
    let sameWeek = 0;
    for (let day = 0; day < 2 * 366; day++) {
      for (const hour of [0, 1, 3, 12, 23]) {
        const now = local(2026, 1, 1 + day, hour, 30);
        const view = describeLife(life, now, 2)!;
        expect(view.current! - previous.current!, `${now.toString()}`).toBeGreaterThanOrEqual(0);
        expect(view.current! - previous.current!, `${now.toString()}`).toBeLessThanOrEqual(1);
        expect(view.fraction).toBeGreaterThanOrEqual(previous.fraction);
        if (view.current === previous.current) sameWeek++;
        previous = view;
      }
    }
    // 52 or 53 steps a year: each square lasts 7 days, the 52nd 8 or 9.
    expect(previous.current! - describeLife(life, local(2025, 12, 31, 12), 2)!.current!).toBeGreaterThanOrEqual(103);
    expect(sameWeek).toBeGreaterThan(0);
  });
});
