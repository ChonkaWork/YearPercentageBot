import { normalizeName, parseDate, truncate, type CalendarDate } from './countdown';
import { formatDateRange, formatInteger, formatPercent, monthName, pad2, plural, type FormattedPercent } from './format';
import { calendarDaysBetween, daysInMonth, fractionBetween } from './time';

/**
 * Goals paced against the calendar: "Read 24 books" this year, with a count the user moves with
 * +1 / −1. On pace means `count ≥ target × share of the period gone`, so on October 16 a 24-book
 * goal for the year expects about 19. Pure: no DOM, no Chrome APIs, no hidden clock.
 */

export const GOAL_PERIODS = ['year', 'quarter', 'month', 'custom'] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];

export interface Goal {
  id: string;
  name: string;
  /** What is counted, as the user writes it for several ("books", "km"). May be empty. */
  unit: string;
  /** Whole number, 1..MAX_GOAL_VALUE. */
  target: number;
  /** Whole number, 0..MAX_GOAL_VALUE. May go past the target. */
  count: number;
  /** How the dates were chosen; 'year' | 'quarter' | 'month' are fixed when the goal is saved. */
  period: GoalPeriod;
  /** First and last day of the period (both included), local `YYYY-MM-DD`. */
  start: string;
  end: string;
  createdAt: number;
}

export type GoalFields = Pick<Goal, 'name' | 'unit' | 'target' | 'count' | 'period' | 'start' | 'end'>;

/** Hard cap for every plan (Pro's "unlimited"); the plan's own limit is checked on add. */
export const MAX_GOALS = 100;
export const MAX_GOAL_NAME_LENGTH = 80;
export const MAX_UNIT_LENGTH = 24;
export const MAX_GOAL_VALUE = 1_000_000;

// --- Periods -----------------------------------------------------------------------------------

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** This year, quarter or month at `now`, as the first and last day. */
export function periodDates(period: Exclude<GoalPeriod, 'custom'>, now: Date): { start: string; end: string } {
  const year = now.getFullYear();
  const month = now.getMonth();
  switch (period) {
    case 'year':
      return { start: isoDate(year, 1, 1), end: isoDate(year, 12, 31) };
    case 'quarter': {
      const first = month - (month % 3);
      return { start: isoDate(year, first + 1, 1), end: isoDate(year, first + 3, daysInMonth(year, first + 2)) };
    }
    case 'month':
      return { start: isoDate(year, month + 1, 1), end: isoDate(year, month + 1, daysInMonth(year, month)) };
  }
}

/**
 * The period as a half-open interval of local time: from the start of the first day to the start
 * of the day after the last. Built from calendar fields, so DST days count as 23 or 25 hours.
 */
export function goalBounds(goal: Pick<Goal, 'start' | 'end'>): { start: Date; end: Date } | null {
  const first = parseDate(goal.start);
  const last = parseDate(goal.end);
  if (!first || !last) return null;
  const start = new Date(first.year, first.month - 1, first.day);
  const end = new Date(last.year, last.month - 1, last.day + 1);
  return end > start ? { start, end } : null;
}

const dateOf = (date: CalendarDate) => new Date(date.year, date.month - 1, date.day);

/** "2026", "Q4 2026", "October 2026", "Oct 1 – Dec 15, 2026" */
export function goalPeriodLabel(goal: Pick<Goal, 'period' | 'start' | 'end'>): string {
  const first = parseDate(goal.start);
  const last = parseDate(goal.end);
  if (!first || !last) return '';
  switch (goal.period) {
    case 'year':
      return String(first.year);
    case 'quarter':
      return `Q${Math.floor((first.month - 1) / 3) + 1} ${first.year}`;
    case 'month':
      return `${monthName(first.month - 1)} ${first.year}`;
    case 'custom': {
      const range = formatDateRange(dateOf(first), dateOf(last));
      return first.year === last.year ? `${range}, ${first.year}` : range;
    }
  }
}

// --- Pace --------------------------------------------------------------------------------------

export type GoalStatus = 'upcoming' | 'behind' | 'on-pace' | 'ahead' | 'reached' | 'missed';

export interface GoalPace {
  status: GoalStatus;
  /** Share of the period gone at `now`, 0..1: where the pace marker sits on the bar. */
  elapsed: number;
  /** Where the count would be exactly on pace: target × elapsed. */
  expected: number;
  /** Whole units ahead (> 0) or behind (< 0) of `expected`; 0 means on pace. */
  difference: number;
}

/**
 * Where a goal stands at `now`. Reached wins over everything (even before the period starts);
 * then a period that hasn't started or is over; otherwise the count against the pace, rounded to
 * whole units so "on pace" means less than half a unit either way.
 */
export function goalPace(goal: Pick<Goal, 'target' | 'count' | 'start' | 'end'>, now: Date): GoalPace | null {
  const bounds = goalBounds(goal);
  if (!bounds) return null;
  const target = Math.max(0, goal.target);
  const count = Math.max(0, goal.count);
  const elapsed = fractionBetween(bounds.start, bounds.end, now);
  const expected = target * elapsed;
  const gap = count - expected;
  // Math.round(-0.5) is -0; round the magnitude instead so .5 always counts as a whole unit.
  const difference = Math.sign(gap) * Math.round(Math.abs(gap));

  let status: GoalStatus;
  if (count >= target) status = 'reached';
  else if (now < bounds.start) status = 'upcoming';
  else if (now >= bounds.end) status = 'missed';
  else if (difference < 0) status = 'behind';
  else if (difference > 0) status = 'ahead';
  else status = 'on-pace';
  return { status, elapsed, expected, difference: difference === 0 ? 0 : difference };
}

/**
 * "2 books", but "1" rather than "1 books": the unit is stored the way it's written for several,
 * and guessing singulars ("movies", "classes") goes wrong more often than leaving it out.
 */
export function amount(value: number, unit: string): string {
  return unit && value !== 1 ? `${formatInteger(value)} ${unit}` : formatInteger(value);
}

export interface GoalView {
  id: string;
  name: string;
  status: GoalStatus;
  /** "17 of 24" */
  countText: string;
  /** "2 books behind pace", "on pace", "3 books ahead", "goal reached", "ended 7 books short" */
  verdict: string;
  /** "17 of 24 · 2 books behind pace" */
  summary: string;
  /** "2026", "Q4 2026", "October 2026", "Oct 1 – Dec 15, 2026" */
  periodLabel: string;
  /** count / target, 0..1 (drives the bar). */
  fraction: number;
  percent: FormattedPercent;
  /** Share of the period gone, 0..1 (the marker). */
  elapsed: number;
  /** "On pace today: 19": the count that reads "on pace" now (the marker's label). */
  paceText: string;
}

export function describeGoal(goal: Goal, now: Date): GoalView | null {
  const pace = goalPace(goal, now);
  if (!pace) return null;
  const { unit, target, count } = goal;
  let verdict: string;
  switch (pace.status) {
    case 'reached':
      verdict = count > target ? `goal reached, ${amount(count - target, unit)} over` : 'goal reached';
      break;
    case 'upcoming': {
      const days = calendarDaysBetween(now, goalBounds(goal)?.start ?? now);
      verdict = days <= 1 ? 'starts tomorrow' : `starts in ${plural(days, 'day', 'days')}`;
      break;
    }
    case 'missed':
      verdict = `ended ${amount(target - count, unit)} short`;
      break;
    case 'behind':
      verdict = `${amount(-pace.difference, unit)} behind pace`;
      break;
    case 'ahead':
      verdict = `${amount(pace.difference, unit)} ahead`;
      break;
    case 'on-pace':
      verdict = 'on pace';
      break;
  }
  const countText = `${formatInteger(count)} of ${formatInteger(target)}`;
  const fraction = target > 0 ? Math.min(1, count / target) : 1;
  return {
    id: goal.id,
    name: goal.name,
    status: pace.status,
    countText,
    verdict,
    summary: `${countText} · ${verdict}`,
    periodLabel: goalPeriodLabel(goal),
    fraction,
    percent: formatPercent(fraction, 0),
    elapsed: pace.elapsed,
    paceText: `On pace today: ${formatInteger(Math.round(pace.expected))}`,
  };
}

// --- Form validation ---------------------------------------------------------------------------

export interface GoalDraft {
  name: string;
  unit: string;
  target: string;
  count: string;
  period: GoalPeriod;
  /** Only read for a custom period. */
  start: string;
  end: string;
  startIncomplete?: boolean;
  endIncomplete?: boolean;
}

export type GoalField = 'name' | 'unit' | 'target' | 'count' | 'start' | 'end';
export type GoalErrors = Partial<Record<GoalField, string>>;
export type GoalResult = { ok: true; value: GoalFields } | { ok: false; errors: GoalErrors };

/** A whole number typed into a field ("1,000" and "1 000" are fine), or null. */
export function parseWholeNumber(text: string): number | null {
  const clean = text.trim().replace(/[\s,_]/g, '');
  if (!/^\d+$/.test(clean)) return null;
  const value = Number(clean);
  return Number.isSafeInteger(value) ? value : null;
}

/** Whether a goal's period is over at `now` (its last day has ended). */
export function periodOver(goal: Pick<Goal, 'start' | 'end'>, now: Date): boolean {
  const bounds = goalBounds(goal);
  return bounds !== null && now >= bounds.end;
}

/**
 * Checks the form. `now` fixes "this year / quarter / month". When an existing goal (`current`)
 * keeps its period kind, its dates are kept too, so fixing a typo on December 31 doesn't reset
 * the pace; once that period is over, saving it moves it to the current year, quarter or month
 * (the form says so), which is how a yearly goal starts again.
 */
export function validateGoalDraft(draft: GoalDraft, now: Date, current?: Pick<Goal, 'period' | 'start' | 'end'>): GoalResult {
  const errors: GoalErrors = {};

  const name = normalizeName(draft.name);
  if (!name) errors.name = 'Give the goal a name.';
  else if (name.length > MAX_GOAL_NAME_LENGTH) errors.name = `Use at most ${MAX_GOAL_NAME_LENGTH} characters.`;

  const unit = normalizeName(draft.unit);
  if (unit.length > MAX_UNIT_LENGTH) errors.unit = `Use at most ${MAX_UNIT_LENGTH} characters.`;

  const target = parseWholeNumber(draft.target);
  if (!draft.target.trim()) errors.target = 'Set a target.';
  else if (target === null) errors.target = 'Use a whole number.';
  else if (target < 1) errors.target = 'Set a target of at least 1.';
  else if (target > MAX_GOAL_VALUE) errors.target = `Use a number up to ${formatInteger(MAX_GOAL_VALUE)}.`;

  const count = draft.count.trim() === '' ? 0 : parseWholeNumber(draft.count);
  if (count === null) errors.count = 'Use a whole number, 0 or more.';
  else if (count > MAX_GOAL_VALUE) errors.count = `Use a number up to ${formatInteger(MAX_GOAL_VALUE)}.`;

  let dates: { start: string; end: string } | null = null;
  if (draft.period === 'custom') {
    const startText = draft.start.trim();
    const endText = draft.end.trim();
    const first = parseDate(startText);
    const last = parseDate(endText);
    if (draft.startIncomplete) errors.start = 'Enter a complete date.';
    else if (!startText) errors.start = 'Pick the first day.';
    else if (!first) errors.start = 'Enter a real date.';
    if (draft.endIncomplete) errors.end = 'Enter a complete date.';
    else if (!endText) errors.end = 'Pick the last day.';
    else if (!last) errors.end = 'Enter a real date.';
    else if (first && endText < startText) errors.end = 'The last day can’t be before the first.';
    if (first && last && !errors.end) dates = { start: startText, end: endText };
  } else if (current && current.period === draft.period && !periodOver(current, now)) {
    dates = { start: current.start, end: current.end };
  } else {
    dates = periodDates(draft.period, now);
  }

  if (Object.keys(errors).length > 0 || !dates || target === null || count === null) return { ok: false, errors };
  return { ok: true, value: { name, unit, target, count, period: draft.period, ...dates } };
}

// --- List operations (pure; storage applies them) ----------------------------------------------

export class GoalLimitError extends Error {
  constructor(message = `You can have up to ${MAX_GOALS} goals. Delete one to add another.`) {
    super(message);
    this.name = 'GoalLimitError';
  }
}

export function createGoal(fields: GoalFields, id: string, now: number): Goal {
  return { id, ...fields, createdAt: now };
}

/**
 * Like addCountdown: `max` only blocks adding; undo passes no `max` and the goal's old `index`, so
 * it comes back where it was.
 */
export function addGoal(list: readonly Goal[], goal: Goal, max = MAX_GOALS, limitMessage?: string, index?: number): Goal[] {
  if (list.some((item) => item.id === goal.id)) return [...list];
  if (list.length >= Math.min(max, MAX_GOALS)) throw new GoalLimitError(max < MAX_GOALS ? limitMessage : undefined);
  const next = [...list];
  next.splice(index === undefined ? next.length : Math.max(0, Math.min(index, next.length)), 0, goal);
  return next;
}

export function updateGoal(list: readonly Goal[], id: string, fields: GoalFields): Goal[] {
  return list.map((item) => (item.id === id ? { ...item, ...fields } : item));
}

/** +1 / −1: the count stays within 0..MAX_GOAL_VALUE. */
export function stepGoal(list: readonly Goal[], id: string, delta: number): Goal[] {
  return list.map((item) => (item.id === id ? { ...item, count: clampCount(item.count + delta) } : item));
}

export function removeGoal(list: readonly Goal[], id: string): Goal[] {
  return list.filter((item) => item.id !== id);
}

function clampCount(value: number): number {
  return Math.min(MAX_GOAL_VALUE, Math.max(0, Math.trunc(value)));
}

function isWhole(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_GOAL_VALUE;
}

/** Accepts anything read from storage and keeps the valid goals (at most MAX_GOALS). */
export function sanitizeGoals(raw: unknown, now: number): Goal[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: Goal[] = [];
  for (const item of raw) {
    if (result.length >= MAX_GOALS) break;
    if (typeof item !== 'object' || item === null) continue;
    const input = item as Record<string, unknown>;
    const id = typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 64 ? input.id : null;
    if (!id || seen.has(id)) continue;
    const name = typeof input.name === 'string' ? truncate(normalizeName(input.name), MAX_GOAL_NAME_LENGTH) : '';
    const unit = typeof input.unit === 'string' ? truncate(normalizeName(input.unit), MAX_UNIT_LENGTH) : '';
    const period = GOAL_PERIODS.includes(input.period as GoalPeriod) ? (input.period as GoalPeriod) : 'custom';
    if (!name || !isWhole(input.target, 1)) continue;
    const start = typeof input.start === 'string' ? input.start.trim() : '';
    const end = typeof input.end === 'string' ? input.end.trim() : '';
    if (!goalBounds({ start, end })) continue;
    const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) && input.createdAt > 0 ? input.createdAt : now;
    seen.add(id);
    result.push({
      id,
      name,
      unit,
      target: input.target,
      count: isWhole(input.count, 0) ? input.count : 0,
      period,
      start,
      end,
      createdAt,
    });
  }
  return result;
}
