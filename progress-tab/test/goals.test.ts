import { describe, expect, it } from 'vitest';
import {
  MAX_GOALS,
  MAX_GOAL_VALUE,
  GoalLimitError,
  addGoal,
  amount,
  createGoal,
  describeGoal,
  goalPace,
  goalPeriodLabel,
  parseWholeNumber,
  periodDates,
  periodOver,
  removeGoal,
  sanitizeGoals,
  stepGoal,
  updateGoal,
  validateGoalDraft,
  type Goal,
  type GoalDraft,
} from '../src/core/goals';
import { FREE_MAX_GOALS, PRO_MAX_GOALS, limitMessage, listLimit } from '../src/core/plan';

// Runs pinned to UTC; time-zone and DST behaviour is in test/zones/goals.test.ts.

const local = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm);

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'g',
    name: 'Read 24 books',
    unit: 'books',
    target: 24,
    count: 17,
    period: 'year',
    start: '2026-01-01',
    end: '2026-12-31',
    createdAt: 1,
    ...overrides,
  };
}

describe('periods', () => {
  it('fixes this year, quarter or month from a date', () => {
    const now = local(2026, 10, 16, 9, 41);
    expect(periodDates('year', now)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(periodDates('quarter', now)).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(periodDates('month', now)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(periodDates('quarter', local(2026, 1, 1))).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(periodDates('quarter', local(2026, 6, 30, 23, 59))).toEqual({ start: '2026-04-01', end: '2026-06-30' });
    expect(periodDates('month', local(2028, 2, 10))).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodDates('month', local(2026, 2, 10))).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('labels the period', () => {
    expect(goalPeriodLabel(goal())).toBe('2026');
    expect(goalPeriodLabel(goal({ period: 'quarter', start: '2026-10-01', end: '2026-12-31' }))).toBe('Q4 2026');
    expect(goalPeriodLabel(goal({ period: 'month', start: '2026-10-01', end: '2026-10-31' }))).toBe('October 2026');
    expect(goalPeriodLabel(goal({ period: 'custom', start: '2026-10-01', end: '2026-12-15' }))).toBe('Oct 1 – Dec 15, 2026');
    expect(goalPeriodLabel(goal({ period: 'custom', start: '2026-11-15', end: '2027-02-01' }))).toBe('Nov 15, 2026 – Feb 1, 2027');
  });
});

describe('goalPace', () => {
  it('pace = target × share of the period gone', () => {
    // Oct 16, 09:41 in 2026: 79.00% of the year.
    const pace = goalPace(goal(), local(2026, 10, 16, 9, 41))!;
    expect(pace.elapsed).toBeCloseTo((local(2026, 10, 16, 9, 41).getTime() - local(2026, 1, 1).getTime()) / (365 * 86_400_000), 12);
    expect(pace.expected).toBeCloseTo(24 * pace.elapsed, 12);
    expect(pace.expected).toBeCloseTo(18.96, 2);
    expect(pace).toMatchObject({ status: 'behind', difference: -2 });
  });

  it('is exactly 0 at the first instant and the target at the end of the last day', () => {
    expect(goalPace(goal({ count: 0 }), local(2026, 1, 1))).toMatchObject({ elapsed: 0, expected: 0, status: 'on-pace', difference: 0 });
    // Last second of Dec 31 is still inside; the period ends at Jan 1, 00:00.
    const last = goalPace(goal({ count: 0 }), new Date(local(2027, 1, 1).getTime() - 1000))!;
    expect(last.elapsed).toBeLessThan(1);
    expect(last.status).toBe('behind');
    expect(goalPace(goal({ count: 23 }), local(2027, 1, 1))).toMatchObject({ elapsed: 1, expected: 24, status: 'missed' });
  });

  it('rounds to whole units: less than half a unit either way is on pace', () => {
    // Mid-year (July 2, 12:00 in a 365-day year is exactly half): 12 books expected.
    const half = local(2026, 7, 2, 12);
    expect(goalPace(goal({ count: 12 }), half)).toMatchObject({ status: 'on-pace', difference: 0 });
    expect(goalPace(goal({ count: 11 }), half)).toMatchObject({ status: 'behind', difference: -1 });
    expect(goalPace(goal({ count: 13 }), half)).toMatchObject({ status: 'ahead', difference: 1 });
    expect(goalPace(goal({ count: 15 }), half)).toMatchObject({ status: 'ahead', difference: 3 });
    // Exactly half a unit counts: 12.5 expected with a target of 25.
    expect(goalPace(goal({ target: 25, count: 12 }), half)).toMatchObject({ status: 'behind', difference: -1 });
    expect(goalPace(goal({ target: 25, count: 13 }), half)).toMatchObject({ status: 'ahead', difference: 1 });
  });

  it('overachievement: reached as soon as count ≥ target, and stays reached', () => {
    const early = local(2026, 3, 1);
    expect(goalPace(goal({ count: 24 }), early)).toMatchObject({ status: 'reached' });
    // Mar 1: 59/365 of the year gone, 3.9 books expected.
    expect(goalPace(goal({ count: 30 }), early)).toMatchObject({ status: 'reached', difference: 26 });
    expect(goalPace(goal({ count: 30 }), local(2027, 6, 1))).toMatchObject({ status: 'reached', elapsed: 1 });
  });

  it('before the period starts: upcoming, nothing expected yet', () => {
    const next = goal({ period: 'custom', start: '2026-11-01', end: '2026-11-30', count: 0, target: 10 });
    expect(goalPace(next, local(2026, 10, 16))).toMatchObject({ status: 'upcoming', elapsed: 0, expected: 0 });
  });

  it('a zero target never divides by zero', () => {
    const zero = goal({ target: 0, count: 0 });
    const pace = goalPace(zero, local(2026, 10, 16))!;
    expect(pace).toMatchObject({ status: 'reached', expected: 0 });
    const view = describeGoal(zero, local(2026, 10, 16))!;
    expect(view.fraction).toBe(1);
    expect(Number.isNaN(view.percent.value)).toBe(false);
    expect(view.summary).toBe('0 of 0 · goal reached');
  });

  it('returns null for broken dates', () => {
    expect(goalPace(goal({ start: '2026-02-30' }), local(2026, 3, 1))).toBeNull();
    expect(goalPace(goal({ start: '2026-12-31', end: '2026-01-01' }), local(2026, 3, 1))).toBeNull();
  });
});

describe('describeGoal', () => {
  const now = local(2026, 10, 16, 9, 41);

  it('reads as a plain verdict', () => {
    expect(describeGoal(goal(), now)).toMatchObject({
      countText: '17 of 24',
      verdict: '2 books behind pace',
      summary: '17 of 24 · 2 books behind pace',
      periodLabel: '2026',
      status: 'behind',
      paceText: 'On pace today: 19',
    });
    expect(describeGoal(goal({ count: 19 }), now)?.summary).toBe('19 of 24 · on pace');
    expect(describeGoal(goal({ count: 22 }), now)?.summary).toBe('22 of 24 · 3 books ahead');
    expect(describeGoal(goal({ count: 18 }), now)?.summary).toBe('18 of 24 · 1 behind pace');
    expect(describeGoal(goal({ unit: '' }), now)?.verdict).toBe('2 behind pace');
    expect(describeGoal(goal({ count: 24 }), now)?.summary).toBe('24 of 24 · goal reached');
    expect(describeGoal(goal({ count: 27 }), now)?.summary).toBe('27 of 24 · goal reached, 3 books over');
    expect(describeGoal(goal({ count: 25 }), now)?.summary).toBe('25 of 24 · goal reached, 1 over');
    expect(describeGoal(goal({ count: 17 }), local(2027, 1, 5))?.summary).toBe('17 of 24 · ended 7 books short');
    expect(describeGoal(goal({ period: 'custom', start: '2026-10-17', end: '2026-10-31' }), now)?.verdict).toBe('starts tomorrow');
    expect(describeGoal(goal({ period: 'custom', start: '2026-10-28', end: '2026-10-31' }), now)?.verdict).toBe('starts in 12 days');
    expect(describeGoal(goal({ target: 5000, count: 1200, unit: 'km' }), now)?.summary).toBe('1,200 of 5,000 · 2,751 km behind pace');
  });

  it('gives the bar and the marker', () => {
    const view = describeGoal(goal(), now)!;
    expect(view.fraction).toBeCloseTo(17 / 24, 12);
    expect(view.percent.text).toBe('70%');
    expect(view.elapsed).toBeCloseTo(0.79, 3);
    expect(describeGoal(goal({ count: 40 }), now)?.fraction).toBe(1);
  });

  it('never pluralizes a unit it can’t: 1 is just "1"', () => {
    expect(amount(2, 'books')).toBe('2 books');
    expect(amount(1, 'books')).toBe('1');
    expect(amount(0, 'books')).toBe('0 books');
    expect(amount(1500, '')).toBe('1,500');
  });
});

describe('validateGoalDraft', () => {
  const now = local(2026, 10, 16, 9, 41);
  const draft: GoalDraft = { name: ' Read 24 books ', unit: ' books ', target: '24', count: '', period: 'year', start: '', end: '' };

  it('returns clean fields with this year by default', () => {
    expect(validateGoalDraft(draft, now)).toEqual({
      ok: true,
      value: { name: 'Read 24 books', unit: 'books', target: 24, count: 0, period: 'year', start: '2026-01-01', end: '2026-12-31' },
    });
    expect(validateGoalDraft({ ...draft, period: 'month', count: '3' }, now)).toMatchObject({
      ok: true,
      value: { count: 3, period: 'month', start: '2026-10-01', end: '2026-10-31' },
    });
    expect(validateGoalDraft({ ...draft, period: 'custom', start: '2026-10-01', end: '2026-10-01' }, now)).toMatchObject({
      ok: true,
      value: { period: 'custom', start: '2026-10-01', end: '2026-10-01' },
    });
  });

  it('keeps the stored dates while the period runs; an ended one moves to the current period', () => {
    const q3 = { period: 'quarter' as const, start: '2026-07-01', end: '2026-09-30' };
    const inQ3 = local(2026, 9, 30, 23, 59);
    expect(periodOver(q3, inQ3)).toBe(false);
    expect(validateGoalDraft({ ...draft, period: 'quarter' }, inQ3, q3)).toMatchObject({ ok: true, value: { start: '2026-07-01', end: '2026-09-30' } });
    // Q3 is over on Oct 16: saving it again starts Q4 (how a recurring goal starts again).
    expect(periodOver(q3, now)).toBe(true);
    expect(validateGoalDraft({ ...draft, period: 'quarter' }, now, q3)).toMatchObject({ ok: true, value: { start: '2026-10-01', end: '2026-12-31' } });
    const lastYear = { period: 'year' as const, start: '2025-01-01', end: '2025-12-31' };
    expect(validateGoalDraft(draft, now, lastYear)).toMatchObject({ ok: true, value: { start: '2026-01-01', end: '2026-12-31' } });
    // Changing the kind always uses the current period; custom dates are always the typed ones.
    expect(validateGoalDraft({ ...draft, period: 'month' }, inQ3, q3)).toMatchObject({ ok: true, value: { start: '2026-09-01', end: '2026-09-30' } });
    expect(validateGoalDraft({ ...draft, period: 'custom', start: '2025-01-01', end: '2025-03-31' }, now, q3)).toMatchObject({
      ok: true,
      value: { start: '2025-01-01', end: '2025-03-31' },
    });
  });

  it('rejects zero or broken targets and counts', () => {
    expect(validateGoalDraft({ ...draft, target: '0' }, now)).toEqual({ ok: false, errors: { target: 'Set a target of at least 1.' } });
    expect(validateGoalDraft({ ...draft, target: '' }, now)).toEqual({ ok: false, errors: { target: 'Set a target.' } });
    expect(validateGoalDraft({ ...draft, target: '2.5' }, now)).toEqual({ ok: false, errors: { target: 'Use a whole number.' } });
    expect(validateGoalDraft({ ...draft, target: '-3' }, now)).toEqual({ ok: false, errors: { target: 'Use a whole number.' } });
    expect(validateGoalDraft({ ...draft, target: String(MAX_GOAL_VALUE + 1) }, now)).toEqual({ ok: false, errors: { target: 'Use a number up to 1,000,000.' } });
    expect(validateGoalDraft({ ...draft, target: '1,000' }, now)).toMatchObject({ ok: true, value: { target: 1000 } });
    expect(validateGoalDraft({ ...draft, count: 'many' }, now)).toEqual({ ok: false, errors: { count: 'Use a whole number, 0 or more.' } });
    // Starting above the target is fine (overachievement).
    expect(validateGoalDraft({ ...draft, count: '30' }, now)).toMatchObject({ ok: true, value: { count: 30 } });
  });

  it('explains every problem at once', () => {
    expect(validateGoalDraft({ ...draft, name: ' ', unit: 'x'.repeat(25), period: 'custom', start: '2026-02-30', end: '' }, now)).toEqual({
      ok: false,
      errors: { name: 'Give the goal a name.', unit: 'Use at most 24 characters.', start: 'Enter a real date.', end: 'Pick the last day.' },
    });
    expect(validateGoalDraft({ ...draft, period: 'custom', start: '2026-10-10', end: '2026-10-01' }, now)).toEqual({
      ok: false,
      errors: { end: 'The last day can’t be before the first.' },
    });
    expect(validateGoalDraft({ ...draft, period: 'custom', start: '', end: '', startIncomplete: true, endIncomplete: true }, now)).toEqual({
      ok: false,
      errors: { start: 'Enter a complete date.', end: 'Enter a complete date.' },
    });
  });

  it('parses whole numbers the way people type them', () => {
    expect(parseWholeNumber(' 1,200 ')).toBe(1200);
    expect(parseWholeNumber('1 200')).toBe(1200);
    expect(parseWholeNumber('0')).toBe(0);
    for (const bad of ['', '1.5', '-1', '1e3', 'ten', '99999999999999999999']) expect(parseWholeNumber(bad), bad).toBeNull();
  });
});

describe('list operations and the plan limit', () => {
  it('creates, steps within 0..max, updates and removes', () => {
    const created = createGoal({ name: 'Run', unit: 'km', target: 500, count: 0, period: 'year', start: '2026-01-01', end: '2026-12-31' }, 'r', 7);
    expect(created).toMatchObject({ id: 'r', createdAt: 7, count: 0 });
    let list = addGoal([goal()], created);
    list = stepGoal(list, 'r', 1);
    list = stepGoal(list, 'r', 1);
    expect(list[1]?.count).toBe(2);
    expect(stepGoal(stepGoal(list, 'r', -1), 'r', -5)[1]?.count).toBe(0);
    expect(stepGoal([goal({ count: MAX_GOAL_VALUE })], 'g', 1)[0]?.count).toBe(MAX_GOAL_VALUE);
    expect(updateGoal(list, 'r', { ...created, name: 'Run 500 km' })[1]).toMatchObject({ id: 'r', name: 'Run 500 km', createdAt: 7 });
    expect(removeGoal(list, 'g').map((g) => g.id)).toEqual(['r']);
    // Undo adds the same id only once, and puts a goal back where it was.
    expect(addGoal(list, created)).toEqual(list);
    expect(addGoal([goal({ id: 'a' }), goal({ id: 'c' })], goal({ id: 'b' }), undefined, undefined, 1).map((g) => g.id)).toEqual(['a', 'b', 'c']);
  });

  it('free tracks 1 goal: adding is blocked, nothing existing is removed', () => {
    const max = listLimit('goals', 'free', false);
    const message = limitMessage('goals', 'free', false);
    expect(max).toBe(FREE_MAX_GOALS);
    expect(message).toBe('Free tracks 1 goal. Pro removes the limit.');
    const three = [goal({ id: 'a' }), goal({ id: 'b' }), goal({ id: 'c' })];
    expect(() => addGoal(three, goal({ id: 'd' }), max, message)).toThrow(new GoalLimitError(message));
    expect(() => addGoal([], goal({ id: 'd' }), max, message)).not.toThrow();
    // Undo after a delete restores without the plan limit.
    expect(addGoal(three, goal({ id: 'd' }))).toHaveLength(4);
    expect(listLimit('goals', 'pro', false)).toBe(PRO_MAX_GOALS);
    expect(PRO_MAX_GOALS).toBe(MAX_GOALS);
    const full = Array.from({ length: MAX_GOALS }, (_, i) => goal({ id: `g${i}` }));
    expect(() => addGoal(full, goal({ id: 'more' }))).toThrow(GoalLimitError);
  });
});

describe('sanitizeGoals', () => {
  it('keeps valid goals and drops broken ones', () => {
    const result = sanitizeGoals(
      [
        goal({ id: 'ok', name: '  Read   24 books ' }),
        goal({ id: 'ok', name: 'Duplicate' }),
        goal({ id: 'zero', target: 0 }),
        goal({ id: 'fraction', target: 2.5 }),
        { ...goal({ id: 'count' }), count: -4 },
        { ...goal({ id: 'kind' }), period: 'decade' },
        goal({ id: 'dates', start: '2026-12-31', end: '2026-01-01' }),
        goal({ id: 'name', name: ' ' }),
        { ...goal({ id: 'created' }), createdAt: 'never' },
        null,
        'x',
      ],
      99,
    );
    expect(result.map((g) => g.id)).toEqual(['ok', 'count', 'kind', 'created']);
    expect(result[0]?.name).toBe('Read 24 books');
    expect(result[1]?.count).toBe(0);
    expect(result[2]?.period).toBe('custom');
    expect(result[3]?.createdAt).toBe(99);
    for (const raw of [undefined, null, {}, 'goals']) expect(sanitizeGoals(raw, 1)).toEqual([]);
    expect(sanitizeGoals(Array.from({ length: MAX_GOALS + 3 }, (_, i) => goal({ id: `g${i}` })), 1)).toHaveLength(MAX_GOALS);
  });
});
