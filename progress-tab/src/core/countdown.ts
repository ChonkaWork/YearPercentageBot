import { formatAgo, formatClock, formatDateMedium, formatDuration, formatPercent, plural, type FormattedPercent } from './format';
import { calendarDaysBetween, calendarDiff, daysInMonth, fractionBetween } from './time';

export interface Countdown {
  id: string;
  name: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Local wall-clock time `HH:MM` (24 h), or null for the start of that day. */
  time: string | null;
  /** When it was added (epoch ms). Progress is measured from here to the target. */
  createdAt: number;
  showProgress: boolean;
}

/** What the add/edit form produces once it is valid. */
export type CountdownFields = Pick<Countdown, 'name' | 'date' | 'time' | 'showProgress'>;

/** Hard cap for every plan (Pro's "unlimited"); the plan's own limit is checked on add. */
export const MAX_COUNTDOWNS = 200;
export const MAX_NAME_LENGTH = 80;
export const MIN_YEAR = 1000;
export const MAX_YEAR = 9999;

export interface CalendarDate {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

export interface ClockTime {
  hour: number;
  minute: number;
}

/** Parses `YYYY-MM-DD` and rejects dates that don't exist (2026-02-29, 2026-04-31). */
export function parseDate(value: unknown): CalendarDate | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month - 1)) return null;
  return { year, month, day };
}

/** Parses `HH:MM` (seconds, as some time inputs report them, are ignored). */
export function parseTime(value: unknown): ClockTime | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Cuts at a code point boundary so an emoji isn't split in half. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let result = '';
  for (const char of value) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result.trim();
}

function normalizeTime(time: ClockTime): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

/** Trims, collapses whitespace and drops control characters. */
export function normalizeName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The instant a countdown ends, in local time. A local time that doesn't exist (skipped by a DST
 * change) resolves to the moment right after the gap, one that happens twice to the first one.
 */
export function countdownTarget(countdown: Pick<Countdown, 'date' | 'time'>): Date | null {
  const date = parseDate(countdown.date);
  if (!date) return null;
  const time = countdown.time === null ? { hour: 0, minute: 0 } : parseTime(countdown.time);
  if (!time) return null;
  return new Date(date.year, date.month - 1, date.day, time.hour, time.minute);
}

// --- Form validation ---------------------------------------------------------------------------

export interface CountdownDraft {
  name: string;
  date: string;
  time: string;
  showProgress: boolean;
  /** The date input holds a partial value it can't report (`validity.badInput`). */
  dateIncomplete?: boolean;
  timeIncomplete?: boolean;
}

export type DraftField = 'name' | 'date' | 'time';
export type DraftErrors = Partial<Record<DraftField, string>>;
export type DraftResult = { ok: true; value: CountdownFields } | { ok: false; errors: DraftErrors };

export function validateDraft(draft: CountdownDraft): DraftResult {
  const errors: DraftErrors = {};

  const name = normalizeName(draft.name);
  if (!name) errors.name = 'Give the countdown a name.';
  else if (name.length > MAX_NAME_LENGTH) errors.name = `Use at most ${MAX_NAME_LENGTH} characters.`;

  const dateText = draft.date.trim();
  const date = parseDate(dateText);
  if (draft.dateIncomplete) errors.date = 'Enter a complete date.';
  else if (!dateText) errors.date = 'Pick a date.';
  else if (!date) errors.date = `Enter a real date between the years ${MIN_YEAR} and ${MAX_YEAR}.`;

  const timeText = draft.time.trim();
  const time = timeText ? parseTime(timeText) : null;
  if (draft.timeIncomplete) errors.time = 'Enter a complete time, or clear it.';
  else if (timeText && !time) errors.time = 'Enter a valid time, or leave it empty.';

  if (Object.keys(errors).length > 0 || !date) return { ok: false, errors };
  return {
    ok: true,
    value: { name, date: dateText, time: time ? normalizeTime(time) : null, showProgress: draft.showProgress },
  };
}

// --- List operations (pure; storage applies them) ----------------------------------------------

export class CountdownLimitError extends Error {
  constructor(message = `You can have up to ${MAX_COUNTDOWNS} countdowns. Delete one to add another.`) {
    super(message);
    this.name = 'CountdownLimitError';
  }
}

export function createCountdown(fields: CountdownFields, id: string, now: number): Countdown {
  return { id, ...fields, createdAt: now };
}

/**
 * Appends a countdown. `max` is the plan's limit (see plan.ts); it only blocks adding, so a list
 * that is already longer (after a downgrade) is kept as it is. Restoring a deleted countdown
 * (undo) passes no `max`: it gives back what the user had.
 */
export function addCountdown(list: readonly Countdown[], countdown: Countdown, max = MAX_COUNTDOWNS, limitMessage?: string): Countdown[] {
  if (list.some((item) => item.id === countdown.id)) return [...list];
  if (list.length >= Math.min(max, MAX_COUNTDOWNS)) throw new CountdownLimitError(max < MAX_COUNTDOWNS ? limitMessage : undefined);
  return [...list, countdown];
}

/** Editing keeps the id and creation time, so progress stays measured from when it was added. */
export function updateCountdown(list: readonly Countdown[], id: string, fields: CountdownFields): Countdown[] {
  return list.map((item) => (item.id === id ? { ...item, ...fields } : item));
}

export function removeCountdown(list: readonly Countdown[], id: string): Countdown[] {
  return list.filter((item) => item.id !== id);
}

/** Accepts anything read from storage and keeps the valid countdowns (at most MAX_COUNTDOWNS). */
export function sanitizeCountdowns(raw: unknown, now: number): Countdown[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: Countdown[] = [];
  for (const item of raw) {
    if (result.length >= MAX_COUNTDOWNS) break;
    if (typeof item !== 'object' || item === null) continue;
    const input = item as Record<string, unknown>;
    const id = typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 64 ? input.id : null;
    if (!id || seen.has(id)) continue;
    const name = typeof input.name === 'string' ? truncate(normalizeName(input.name), MAX_NAME_LENGTH) : '';
    if (!name || !parseDate(input.date)) continue;
    let time: string | null = null;
    if (input.time !== null && input.time !== undefined && input.time !== '') {
      const parsed = parseTime(input.time);
      if (!parsed) continue;
      time = normalizeTime(parsed);
    }
    const createdAt =
      typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) && input.createdAt > 0 ? input.createdAt : now;
    seen.add(id);
    result.push({
      id,
      name,
      date: (input.date as string).trim(),
      time,
      createdAt,
      showProgress: typeof input.showProgress === 'boolean' ? input.showProgress : true,
    });
  }
  return result;
}

// --- Presentation ------------------------------------------------------------------------------

export type CountdownState = 'upcoming' | 'today' | 'passed';

export interface CountdownView {
  id: string;
  name: string;
  state: CountdownState;
  /** "12 days 4 h", "Today", "passed 3 days ago" */
  statusText: string;
  /** "Fri, Dec 25, 2026 · 18:00" */
  targetText: string;
  /** Progress from creation to the target while upcoming; null when turned off, over, or nothing to measure. */
  progress: FormattedPercent | null;
  fraction: number | null;
}

export function countdownState(countdown: Countdown, now: Date): CountdownState | null {
  const target = countdownTarget(countdown);
  if (!target) return null;
  if (now.getTime() < target.getTime()) return 'upcoming';
  // A date without a time is "today" for that whole day, not "passed" from 00:00:01.
  if (countdown.time === null && calendarDaysBetween(target, now) === 0) return 'today';
  return 'passed';
}

export function describeCountdown(
  countdown: Countdown,
  now: Date,
  options: { hour12: boolean; decimals: number },
): CountdownView | null {
  const target = countdownTarget(countdown);
  const state = countdownState(countdown, now);
  const date = parseDate(countdown.date);
  if (!target || !state || !date) return null;

  let statusText: string;
  if (state === 'upcoming') statusText = formatDuration(calendarDiff(now, target));
  else if (state === 'today') statusText = 'Today';
  else if (countdown.time === null) statusText = `passed ${plural(calendarDaysBetween(target, now), 'day', 'days')} ago`;
  else statusText = formatAgo(calendarDiff(target, now));

  const time = countdown.time === null ? null : parseTime(countdown.time);
  const targetText =
    formatDateMedium(date.year, date.month - 1, date.day) + (time ? ` · ${formatClock(time.hour, time.minute, options.hour12)}` : '');

  let fraction: number | null = null;
  if (countdown.showProgress && state === 'upcoming' && target.getTime() > countdown.createdAt) {
    fraction = fractionBetween(countdown.createdAt, target, now);
  }

  return {
    id: countdown.id,
    name: countdown.name,
    state,
    statusText,
    targetText,
    fraction,
    progress: fraction === null ? null : formatPercent(fraction, options.decimals),
  };
}

const STATE_ORDER: Record<CountdownState, number> = { today: 0, upcoming: 1, passed: 2 };

/**
 * Nearest first: today's dates, then upcoming ones (soonest first), then passed ones (most recent
 * first). Ties keep a stable order by name and creation time.
 */
export function sortCountdowns(list: readonly Countdown[], now: Date): Countdown[] {
  const keyed = list.map((countdown) => ({
    countdown,
    state: countdownState(countdown, now) ?? 'passed',
    target: countdownTarget(countdown)?.getTime() ?? Number.NEGATIVE_INFINITY,
  }));
  keyed.sort((a, b) => {
    if (a.state !== b.state) return STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (a.target !== b.target) return a.state === 'passed' ? b.target - a.target : a.target - b.target;
    return a.countdown.name.localeCompare(b.countdown.name) || a.countdown.createdAt - b.countdown.createdAt;
  });
  return keyed.map((entry) => entry.countdown);
}
