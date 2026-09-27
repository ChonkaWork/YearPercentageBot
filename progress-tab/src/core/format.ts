import type { DurationParts } from './time';

/**
 * English text formatting. Month and weekday names are spelled out here instead of going through
 * Intl so the output is identical in every browser locale and in tests.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function weekdayName(day: number): string {
  return WEEKDAYS[((day % 7) + 7) % 7] ?? '';
}

export function weekdayShort(day: number): string {
  return weekdayName(day).slice(0, 3);
}

/** `month` is 0-based. */
export function monthName(month: number): string {
  return MONTHS[((month % 12) + 12) % 12] ?? '';
}

export function monthShort(month: number): string {
  return monthName(month).slice(0, 3);
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 12345 -> "12,345" */
export function formatInteger(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function plural(count: number, one: string, many: string): string {
  return `${formatInteger(count)} ${count === 1 ? one : many}`;
}

export interface FormattedPercent {
  /** The shown number, e.g. 74.12 (for aria-valuenow). */
  value: number;
  /** "74.12%" */
  text: string;
}

/**
 * Percent of `fraction`, rounded down to `decimals` places. Rounding down means 100% shows only
 * when a period is really over: the last second of a year reads 99.99%, never 100.00%.
 */
export function formatPercent(fraction: number, decimals: number): FormattedPercent {
  const places = Math.min(6, Math.max(0, Math.trunc(decimals) || 0));
  const scale = 10 ** places;
  const full = 100 * scale;
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  // The epsilon absorbs float noise (0.29 * 10000 = 2899.9999999999995) without rounding up
  // anything that is really below the next step.
  let units = Math.min(full, Math.floor(clamped * full + 1e-7));
  if (clamped < 1 && units >= full) units = full - 1;
  const whole = Math.floor(units / scale);
  const text = places === 0 ? `${whole}%` : `${whole}.${String(units % scale).padStart(places, '0')}%`;
  return { value: units / scale, text };
}

/**
 * "12 days 4 h", "4 h 12 min", "12 min 5 s", "5 s". Zero parts are left out.
 *
 * From one hour up, seconds aren't shown and the rest is rounded up to the whole minute, so the
 * text agrees with the clock: at 12:01:30 a day has "11 h 59 min" left, like 24:00 − 12:01.
 */
export function formatDuration(parts: DurationParts): string {
  const { days, hours, minutes, seconds } = roundUpToMinute(parts);
  if (days > 0) return hours > 0 ? `${plural(days, 'day', 'days')} ${hours} h` : plural(days, 'day', 'days');
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
  return `${seconds} s`;
}

function roundUpToMinute(parts: DurationParts): DurationParts {
  if ((parts.days === 0 && parts.hours === 0) || parts.seconds === 0) return parts;
  let { days, hours, minutes } = parts;
  minutes += 1;
  if (minutes === 60) {
    minutes = 0;
    hours += 1;
  }
  // Only once there are whole days: below a day "24 h" is right (e.g. at 00:00:30).
  if (days > 0 && hours >= 24) {
    days += 1;
    hours -= 24;
  }
  return { days, hours, minutes, seconds: 0 };
}

/** "passed 3 days ago", "passed 5 h ago", "passed just now". */
export function formatAgo(parts: DurationParts): string {
  if (parts.days > 0) return `passed ${plural(parts.days, 'day', 'days')} ago`;
  if (parts.hours > 0) return `passed ${parts.hours} h ago`;
  if (parts.minutes > 0) return `passed ${parts.minutes} min ago`;
  return 'passed just now';
}

/** "14:05" or "2:05 PM". */
export function formatClock(hours: number, minutes: number, hour12: boolean): string {
  if (!hour12) return `${pad2(hours)}:${pad2(minutes)}`;
  return `${hours % 12 || 12}:${pad2(minutes)} ${hours < 12 ? 'AM' : 'PM'}`;
}

export function formatTime(date: Date, hour12: boolean): string {
  return formatClock(date.getHours(), date.getMinutes(), hour12);
}

/** "Sunday, September 27" */
export function formatDateLong(date: Date): string {
  return `${weekdayName(date.getDay())}, ${monthName(date.getMonth())} ${date.getDate()}`;
}

/** "Fri, Dec 25, 2026" (month 0-based). */
export function formatDateMedium(year: number, month: number, day: number): string {
  const weekday = new Date(Date.UTC(year, month, day)).getUTCDay();
  return `${weekdayShort(weekday)}, ${monthShort(month)} ${day}, ${year}`;
}

/** Inclusive date range: "Sep 21 – 27", "Sep 27 – Oct 3", "Dec 28, 2026 – Jan 3, 2027". */
export function formatDateRange(first: Date, last: Date): string {
  const from = `${monthShort(first.getMonth())} ${first.getDate()}`;
  if (first.getFullYear() !== last.getFullYear()) {
    return `${from}, ${first.getFullYear()} – ${monthShort(last.getMonth())} ${last.getDate()}, ${last.getFullYear()}`;
  }
  if (first.getMonth() !== last.getMonth()) return `${from} – ${monthShort(last.getMonth())} ${last.getDate()}`;
  return `${from} – ${last.getDate()}`;
}

/** 23 -> "23", 23.5 -> "23.5", 24.75 -> "24.75" */
export function formatHours(ms: number): string {
  return String(Math.round((ms / 3_600_000) * 100) / 100);
}
