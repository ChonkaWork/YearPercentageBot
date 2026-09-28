import { parseDate, type CalendarDate } from './countdown';
import { formatInteger, formatPercent, plural, type FormattedPercent } from './format';
import { calendarDaysBetween, fractionBetween } from './time';

/**
 * "Life in weeks" (Pro): a lifetime drawn as a grid, one column per year of age and one square per
 * week of that year. Pure: the page draws `LifeView` on a canvas.
 *
 * The grid has 52 squares per year (the classic poster). A year of age is 365 or 366 days, so its
 * 52nd square also holds the last day or two; the text uses real weeks (7 days) instead, which is
 * why "weeks left" says "about".
 */

export interface LifeSettings {
  /** Local calendar date `YYYY-MM-DD`, or null until the user sets one. Stored only in this browser. */
  birthDate: string | null;
  /** Expected life span in years. */
  years: number;
}

export const DEFAULT_LIFE_YEARS = 80;
export const MIN_LIFE_YEARS = 20;
export const MAX_LIFE_YEARS = 120;
export const MIN_BIRTH_YEAR = 1900;
export const WEEKS_PER_YEAR = 52;

export const DEFAULT_LIFE: Readonly<LifeSettings> = Object.freeze({ birthDate: null, years: DEFAULT_LIFE_YEARS });

export function parseBirthDate(value: unknown): CalendarDate | null {
  const date = parseDate(value);
  return date && date.year >= MIN_BIRTH_YEAR ? date : null;
}

function isLifeYears(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_LIFE_YEARS && value <= MAX_LIFE_YEARS;
}

/** Accepts anything read from storage. */
export function sanitizeLife(raw: unknown): LifeSettings {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const birthDate = typeof input.birthDate === 'string' && parseBirthDate(input.birthDate) ? input.birthDate.trim() : null;
  return { birthDate, years: isLifeYears(input.years) ? input.years : DEFAULT_LIFE_YEARS };
}

// --- Form ------------------------------------------------------------------------------------

export interface LifeDraft {
  birthDate: string;
  years: string;
  /** The date input holds a partial value it can't report (`validity.badInput`). */
  birthDateIncomplete?: boolean;
}

export type LifeField = 'birthDate' | 'years';
export type LifeResult = { ok: true; value: LifeSettings } | { ok: false; errors: Partial<Record<LifeField, string>> };

export function validateLifeDraft(draft: LifeDraft, now: Date): LifeResult {
  const errors: Partial<Record<LifeField, string>> = {};
  const text = draft.birthDate.trim();
  const date = parseBirthDate(text);
  if (draft.birthDateIncomplete) errors.birthDate = 'Enter a complete date.';
  else if (!text) errors.birthDate = 'Enter your birth date.';
  else if (!date) errors.birthDate = `Enter a real date from ${MIN_BIRTH_YEAR} on.`;
  else if (new Date(date.year, date.month - 1, date.day) > now) errors.birthDate = 'That date is in the future.';

  const yearsText = draft.years.trim();
  const years = yearsText === '' ? DEFAULT_LIFE_YEARS : Number(yearsText);
  if (!isLifeYears(years)) errors.years = `Use a whole number from ${MIN_LIFE_YEARS} to ${MAX_LIFE_YEARS}.`;

  if (Object.keys(errors).length > 0 || !date) return { ok: false, errors };
  return { ok: true, value: { birthDate: text, years } };
}

// --- View ------------------------------------------------------------------------------------

export type LifeState = 'unborn' | 'living' | 'past';

export interface LifeView {
  state: LifeState;
  years: number;
  /** Grid size: years × 52. */
  columns: number;
  rows: number;
  /** Squares before the current week (filled). Squares are numbered column by column. */
  filled: number;
  /** The square of the current week, or null before birth or after the span. */
  current: number | null;
  /** Completed years of age. */
  age: number;
  /** 1-based week within the current year of age (1..52). */
  weekOfYear: number;
  /** Real 7-day weeks since birth, and in the whole span. */
  weeksLived: number;
  weeksTotal: number;
  weeksLeft: number;
  fraction: number;
  percent: FormattedPercent;
  /** "Age 41 · week 23 of 52" */
  caption: string;
  /** One sentence for screen readers and the visible summary. */
  summary: string;
}

/** Local start of the `age`-th birthday. Feb 29 falls on Mar 1 in other years (Date rolls over). */
function birthday(birth: CalendarDate, age: number): Date {
  return new Date(birth.year + age, birth.month - 1, birth.day);
}

export function describeLife(life: LifeSettings, now: Date, decimals: number): LifeView | null {
  const birth = parseBirthDate(life.birthDate);
  if (!birth) return null;
  const years = isLifeYears(life.years) ? life.years : DEFAULT_LIFE_YEARS;
  const start = birthday(birth, 0);
  const end = birthday(birth, years);
  const rows = WEEKS_PER_YEAR;
  const total = years * rows;

  const fraction = fractionBetween(start, end, now);
  const percent = formatPercent(fraction, decimals);
  const weeksTotal = Math.floor(calendarDaysBetween(start, end) / 7);
  const weeksLived = Math.min(weeksTotal, Math.max(0, Math.floor(calendarDaysBetween(start, now) / 7)));
  const weeksLeft = weeksTotal - weeksLived;

  let age = now.getFullYear() - birth.year;
  if (birthday(birth, age) > now) age -= 1;

  const base = { years, columns: years, rows, weeksLived, weeksTotal, weeksLeft, fraction, percent };
  if (now < start) {
    return {
      ...base,
      state: 'unborn',
      filled: 0,
      current: null,
      age: 0,
      weekOfYear: 0,
      caption: 'Birth date is in the future',
      summary: 'The birth date is in the future, so nothing is filled in yet.',
    };
  }
  if (age >= years) {
    return {
      ...base,
      state: 'past',
      filled: total,
      current: null,
      age,
      weekOfYear: 0,
      caption: `Age ${age} · past the ${years} years you set`,
      summary: `${plural(weeksLived, 'week', 'weeks')} lived, past the ${years}-year span you set.`,
    };
  }
  const week = Math.min(rows - 1, Math.floor(calendarDaysBetween(birthday(birth, age), now) / 7));
  const current = age * rows + week;
  return {
    ...base,
    state: 'living',
    filled: current,
    current,
    age,
    weekOfYear: week + 1,
    caption: `Age ${age} · week ${week + 1} of ${rows}`,
    summary: `${plural(weeksLived, 'week', 'weeks')} lived, about ${formatInteger(weeksLeft)} left of ${years} years (${percent.text}).`,
  };
}
