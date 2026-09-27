/**
 * Calendar math in the local time zone. No DOM, no Chrome APIs, no hidden clock: every function
 * takes the dates it needs, so it can be tested with fixed dates in any time zone.
 *
 * Boundaries are always built from calendar fields (`new Date(y, m, d)`), never by adding 24 h
 * worth of milliseconds, so days that are 23, 23.5, 24.5 or 25 hours long (DST changes) come out
 * right. Where midnight doesn't exist (e.g. America/Santiago on DST day) the JS Date constructor
 * moves forward to the first real instant of that day, which is exactly the start we want.
 *
 * Years below 100 are not supported (`new Date(99, 0)` means 1999). Callers validate years.
 */

export const PERIOD_KINDS = ['year', 'month', 'week', 'day'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export const WEEK_STARTS = ['monday', 'sunday'] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** A nominal day. Only for estimates and for UTC-based date arithmetic, never for local boundaries. */
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Half-open interval: start <= t < end. */
export interface Period {
  kind: PeriodKind;
  start: Date;
  end: Date;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

/** `month` is 0-based like Date#getMonth. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** First instant of the local calendar day that contains `date`. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Same wall-clock time `days` calendar days later (or earlier). Across a DST change the result is
 * 23 or 25 hours away, not 24. If that wall-clock time doesn't exist on the target day, the Date
 * constructor moves it forward past the gap.
 */
export function addDays(date: Date, days: number): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

/** Day of the week number (Date#getDay) a week starts on. */
export function firstDayOfWeek(weekStart: WeekStart): number {
  return weekStart === 'sunday' ? 0 : 1;
}

export function startOfWeek(date: Date, weekStart: WeekStart): Date {
  const offset = (date.getDay() - firstDayOfWeek(weekStart) + 7) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

/** The year, month, week or day that contains `now`. */
export function periodAt(kind: PeriodKind, now: Date, weekStart: WeekStart): Period {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  switch (kind) {
    case 'year':
      return { kind, start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
    case 'month':
      return { kind, start: new Date(y, m, 1), end: new Date(y, m + 1, 1) };
    case 'week': {
      const start = startOfWeek(now, weekStart);
      return { kind, start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) };
    }
    case 'day':
      return { kind, start: new Date(y, m, d), end: new Date(y, m, d + 1) };
  }
}

/** Elapsed share of [start, end) at `now`, in real time, clamped to 0..1. */
export function fractionBetween(start: Date | number, end: Date | number, now: Date | number): number {
  const from = Number(start);
  const to = Number(end);
  const at = Number(now);
  if (!(to > from) || !Number.isFinite(at)) return at >= to ? 1 : 0;
  return Math.min(1, Math.max(0, (at - from) / (to - from)));
}

/** Whole calendar days from the date of `from` to the date of `to`, ignoring the time of day. */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / MS_PER_DAY);
}

/** 1-based: January 1 is day 1. */
export function dayOfYear(date: Date): number {
  return calendarDaysBetween(new Date(date.getFullYear(), 0, 1), date) + 1;
}

export interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export const ZERO_DURATION: Readonly<DurationParts> = Object.freeze({ days: 0, hours: 0, minutes: 0, seconds: 0 });

/**
 * Time from `from` to `to` as whole calendar days plus the rest in real hours, minutes and
 * seconds (sub-second remainders are dropped). "12 days" means the same wall-clock time 12 dates
 * later even when a DST change happens in between; the hour part is real time, so on a 25-hour day
 * it can read 24 h. Returns zero when `to` is not after `from`.
 */
export function calendarDiff(from: Date, to: Date): DurationParts {
  const target = to.getTime();
  const total = target - from.getTime();
  if (!(total > 0)) return { ...ZERO_DURATION };

  // `from` itself for day 0: rebuilding it from its fields would pick the earlier of two instants
  // when it falls in the repeated hour of a DST change.
  const dayAfter = (days: number) => (days === 0 ? from.getTime() : addDays(from, days).getTime());

  // Start from the nominal estimate, then correct it: DST can move the boundary by an hour or so.
  let days = Math.floor(total / MS_PER_DAY);
  while (days > 0 && dayAfter(days) > target) days--;
  while (dayAfter(days + 1) <= target) days++;

  let rest = Math.floor((target - dayAfter(days)) / MS_PER_SECOND);
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  return { days, hours, minutes, seconds: rest - minutes * 60 };
}

/** Real length of the local day containing `date`, in milliseconds (usually 24 h). */
export function dayLengthMs(date: Date): number {
  const { start, end } = periodAt('day', date, 'monday');
  return end.getTime() - start.getTime();
}

/** Drops milliseconds, so every display derived from `now` changes exactly on the second. */
export function floorToSecond(date: Date | number): Date {
  const ms = Number(date);
  return new Date(ms - (((ms % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND));
}
