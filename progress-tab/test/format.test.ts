import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatClock,
  formatDateLong,
  formatDateMedium,
  formatDateRange,
  formatDuration,
  formatDurationShort,
  durationTokens,
  formatHours,
  formatInteger,
  formatPercent,
  monthName,
  weekdayName,
} from '../src/core/format';

const d = (days: number, hours = 0, minutes = 0, seconds = 0) => ({ days, hours, minutes, seconds });

describe('formatPercent', () => {
  it('rounds down so a period never shows 100% early', () => {
    expect(formatPercent(0.738356, 2)).toEqual({ value: 73.83, text: '73.83%' });
    expect(formatPercent(0.99999996829, 2).text).toBe('99.99%');
    expect(formatPercent(0.9999999999999, 4).text).toBe('99.9999%');
    expect(formatPercent(0.9996, 1).text).toBe('99.9%');
    expect(formatPercent(1, 2).text).toBe('100.00%');
    expect(formatPercent(0, 2).text).toBe('0.00%');
  });

  it('is not fooled by floating point noise', () => {
    expect(formatPercent(0.29, 2).text).toBe('29.00%');
    expect(formatPercent(0.57, 1).text).toBe('57.0%');
    expect(formatPercent(0.1 + 0.2, 1).text).toBe('30.0%');
  });

  it('supports 0 to 4 decimals and clamps odd input', () => {
    expect(formatPercent(0.74129, 0).text).toBe('74%');
    expect(formatPercent(0.74129, 3).text).toBe('74.129%');
    expect(formatPercent(0.0000123, 4).text).toBe('0.0012%');
    expect(formatPercent(-0.5, 1).text).toBe('0.0%');
    expect(formatPercent(7, 1).text).toBe('100.0%');
    expect(formatPercent(Number.NaN, 1).text).toBe('0.0%');
    expect(formatPercent(0.5, Number.NaN).text).toBe('50%');
  });
});

describe('short durations (visible)', () => {
  const d = (days: number, hours = 0, minutes = 0, seconds = 0) => ({ days, hours, minutes, seconds });
  it('uses short units with the same parts and rounding as formatDuration', () => {
    expect(formatDurationShort(d(183, 21, 59, 30))).toBe('183 d 22 h');
    expect(formatDurationShort(d(1, 0, 59))).toBe('1 d');
    expect(formatDurationShort(d(0, 4, 12))).toBe('4 h 12 min');
    expect(formatDurationShort(d(0, 0, 12, 5))).toBe('12 min 5 s');
    expect(formatDurationShort(d(0, 0, 0, 5))).toBe('5 s');
    expect(formatDurationShort(d(12345, 1))).toBe('12,345 d 1 h');
    expect(durationTokens(d(95, 11, 59, 59))).toEqual([
      { value: '95', unit: 'd' },
      { value: '12', unit: 'h' },
    ]);
    // Same numbers as the spoken form, every time.
    for (const parts of [d(0, 23, 59, 30), d(2, 23, 59, 1), d(0, 0, 59, 59), d(7, 0, 0, 0)]) {
      expect(formatDurationShort(parts).replace(/\D+/g, ' ')).toBe(formatDuration(parts).replace(/\D+/g, ' '));
    }
  });
});

describe('formatDuration', () => {
  it('shows the two largest units', () => {
    expect(formatDuration(d(12, 4, 30, 10))).toBe('12 days 4 h');
    expect(formatDuration(d(1, 0, 59))).toBe('1 day');
    expect(formatDuration(d(0, 4, 12))).toBe('4 h 12 min');
    expect(formatDuration(d(0, 4, 0))).toBe('4 h');
    expect(formatDuration(d(0, 0, 12, 5))).toBe('12 min 5 s');
    expect(formatDuration(d(0, 0, 12, 0))).toBe('12 min');
    expect(formatDuration(d(0, 0, 0, 5))).toBe('5 s');
    expect(formatDuration(d(0, 0, 0, 0))).toBe('0 s');
    expect(formatDuration(d(12345, 1))).toBe('12,345 days 1 h');
  });

  it('rounds up to the minute from one hour on, so it agrees with the clock', () => {
    expect(formatDuration(d(0, 11, 58, 59))).toBe('11 h 59 min');
    expect(formatDuration(d(0, 4, 12, 30))).toBe('4 h 13 min');
    expect(formatDuration(d(0, 4, 59, 1))).toBe('5 h');
    expect(formatDuration(d(0, 23, 59, 30))).toBe('24 h');
    expect(formatDuration(d(0, 24, 29, 30))).toBe('24 h 30 min');
    expect(formatDuration(d(95, 11, 59, 59))).toBe('95 days 12 h');
    expect(formatDuration(d(3, 23, 59, 30))).toBe('4 days');
    expect(formatDuration(d(0, 0, 59, 59))).toBe('59 min 59 s');
    expect(formatDuration(d(0, 1, 0, 1))).toBe('1 h 1 min');
  });

  it('formats time since', () => {
    expect(formatAgo(d(1, 3))).toBe('passed 1 day ago');
    expect(formatAgo(d(3))).toBe('passed 3 days ago');
    expect(formatAgo(d(0, 5, 59))).toBe('passed 5 h ago');
    expect(formatAgo(d(0, 0, 1, 59))).toBe('passed 1 min ago');
    expect(formatAgo(d(0, 0, 0, 59))).toBe('passed just now');
  });
});

describe('clock and dates', () => {
  it('formats 24 h and 12 h times', () => {
    expect(formatClock(0, 0, false)).toBe('00:00');
    expect(formatClock(0, 5, true)).toBe('12:05 AM');
    expect(formatClock(9, 7, true)).toBe('9:07 AM');
    expect(formatClock(12, 0, true)).toBe('12:00 PM');
    expect(formatClock(23, 59, true)).toBe('11:59 PM');
    expect(formatClock(23, 59, false)).toBe('23:59');
  });

  it('spells out dates in English', () => {
    expect(formatDateLong(new Date(2026, 8, 27, 12))).toBe('Sunday, September 27');
    expect(formatDateMedium(2026, 11, 25)).toBe('Fri, Dec 25, 2026');
    expect(formatDateMedium(2024, 1, 29)).toBe('Thu, Feb 29, 2024');
    expect(monthName(0)).toBe('January');
    expect(monthName(-1)).toBe('December');
    expect(weekdayName(7)).toBe('Sunday');
  });

  it('formats date ranges compactly', () => {
    expect(formatDateRange(new Date(2026, 8, 21), new Date(2026, 8, 27))).toBe('Sep 21 – 27');
    expect(formatDateRange(new Date(2026, 8, 27), new Date(2026, 9, 3))).toBe('Sep 27 – Oct 3');
    expect(formatDateRange(new Date(2026, 11, 28), new Date(2027, 0, 3))).toBe('Dec 28, 2026 – Jan 3, 2027');
  });

  it('formats numbers', () => {
    expect(formatInteger(1234567)).toBe('1,234,567');
    expect(formatInteger(999)).toBe('999');
    expect(formatHours(23.5 * 3_600_000)).toBe('23.5');
    expect(formatHours(25 * 3_600_000)).toBe('25');
  });
});
