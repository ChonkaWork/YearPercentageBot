import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatDuration,
  formatNumber,
  formatPercent,
  formatPoints,
  formatPrice,
  formatRatio,
  formatSignificant,
  MISSING,
} from '../src/core/format';

describe('format', () => {
  it.each([
    [64231.5, '64,231.50'],
    [142.371, '142.37'],
    [1, '1.00'],
    [0.5234, '0.5234'],
    [0.08231, '0.08231'],
    [0.00001234, '0.00001234'],
    [0, '0.00'],
  ])('price %f → %s', (value, text) => {
    expect(formatPrice(value)).toBe(text);
  });

  it('never prints NaN, Infinity or undefined', () => {
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null];
    for (const value of bad) {
      for (const format of [formatPrice, formatPercent, formatNumber, formatSignificant, formatRatio, formatPoints, formatAge, formatDuration]) {
        expect(format(value as number)).toBe(MISSING);
      }
    }
    expect(formatPrice(-1)).toBe(MISSING);
  });

  it('signs percentages with a real minus', () => {
    expect(formatPercent(2.345)).toBe('+2.35%');
    expect(formatPercent(-1.2)).toBe('−1.20%');
    expect(formatPercent(0.001)).toBe('0.00%');
    expect(formatPercent(-0.001)).toBe('0.00%');
  });

  it('formats small indicator values with significant digits', () => {
    expect(formatSignificant(0.000012345)).toBe('0.00001235');
    expect(formatSignificant(-152.61)).toBe('−152.6');
    expect(formatSignificant(12345.6)).toBe('12,346');
  });

  it('ratios, points and ages', () => {
    expect(formatRatio(1.84)).toBe('1.8×');
    expect(formatRatio(12.2)).toBe('12×');
    expect(formatPoints(2)).toBe('+2');
    expect(formatPoints(-1)).toBe('−1');
    expect(formatPoints(0)).toBe('0');
    const now = 1_000_000_000;
    expect(formatAge(now - 2_000, now)).toBe('just now');
    expect(formatAge(now - 12_000, now)).toBe('12 sec ago');
    expect(formatAge(now - 3 * 60_000, now)).toBe('3 min ago');
    expect(formatAge(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(formatAge(now - 30 * 3_600_000, now)).toBe('yesterday');
    expect(formatAge(now + 5_000, now)).toBe('just now');
    expect(formatDuration(42_100)).toBe('43 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
});
