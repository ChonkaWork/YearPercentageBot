import { formatDateLong, formatDateRange, formatDuration, formatHours, formatPercent, formatTime, monthName, weekdayName, type FormattedPercent } from './format';
import {
  MS_PER_DAY,
  calendarDiff,
  dayOfYear,
  daysInMonth,
  daysInYear,
  fractionBetween,
  periodAt,
  type PeriodKind,
  type WeekStart,
} from './time';

export interface PeriodView {
  kind: PeriodKind;
  /** "2026", "September", "This week", "Today" */
  label: string;
  /** "Day 270 of 365", "Day 27 of 30", "Sep 21 – 27", "Sunday" */
  caption: string;
  /** Exact elapsed share, 0..1 (drives the bar). */
  fraction: number;
  /** Rounded down for display: "74.12%". */
  percent: FormattedPercent;
  /** "95 days 12 h left" */
  remainingText: string;
}

export interface PeriodOptions {
  weekStart: WeekStart;
  decimals: number;
}

export function describePeriod(kind: PeriodKind, now: Date, options: PeriodOptions): PeriodView {
  const period = periodAt(kind, now, options.weekStart);
  const fraction = fractionBetween(period.start, period.end, now);
  const year = now.getFullYear();
  const month = now.getMonth();

  let label: string;
  let caption: string;
  switch (kind) {
    case 'year':
      label = String(year);
      caption = `Day ${dayOfYear(now)} of ${daysInYear(year)}`;
      break;
    case 'month':
      label = monthName(month);
      caption = `Day ${now.getDate()} of ${daysInMonth(year, month)}`;
      break;
    case 'week': {
      const { start, end } = period;
      label = 'This week';
      caption = formatDateRange(start, new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1));
      break;
    }
    case 'day': {
      label = 'Today';
      caption = weekdayName(now.getDay()) + dstNote(period.end.getTime() - period.start.getTime());
      break;
    }
  }

  return {
    kind,
    label,
    caption,
    fraction,
    percent: formatPercent(fraction, options.decimals),
    remainingText: `${formatDuration(calendarDiff(now, period.end))} left`,
  };
}

/** " · 25-hour day, clocks go back" on DST days, empty otherwise. */
export function dstNote(dayLengthMs: number): string {
  if (dayLengthMs === MS_PER_DAY) return '';
  const direction = dayLengthMs > MS_PER_DAY ? 'back' : 'forward';
  return ` · ${formatHours(dayLengthMs)}-hour day, clocks go ${direction}`;
}

export interface ClockView {
  /** "14:05" or "2:05 PM" */
  time: string;
  /** "Sunday, September 27" */
  date: string;
}

export function describeClock(now: Date, hour12: boolean): ClockView {
  return { time: formatTime(now, hour12), date: formatDateLong(now) };
}
