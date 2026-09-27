import { describe, expect, it } from 'vitest';
import { changeDirection, formatPp, formatPpMagnitude, formatProbability, formatRatio, formatUsd, plural, relativeTime } from '../src/core/format';
import { clamp, isFiniteNumber, roundTo, sign, standardDeviation, toFiniteNumber, toNonNegative, toPp } from '../src/core/numbers';

describe('numbers', () => {
  it('accepts finite numbers and numeric strings only', () => {
    expect(toFiniteNumber(0.62)).toBe(0.62);
    expect(toFiniteNumber('0.62')).toBe(0.62);
    expect(toFiniteNumber(' 12345.6789 ')).toBe(12345.6789);
    expect(toFiniteNumber('1e3')).toBe(1000);
    expect(toFiniteNumber('-.5')).toBe(-0.5);
    for (const bad of ['', ' ', 'abc', '0x10', '1,000', 'NaN', 'Infinity', '12abc', null, undefined, true, {}, [], NaN, Infinity, -Infinity]) {
      expect(toFiniteNumber(bad)).toBeNull();
    }
  });

  it('non-negative guard, clamp, sign, rounding', () => {
    expect(toNonNegative('-1')).toBeNull();
    expect(toNonNegative('0')).toBe(0);
    expect(clamp(7, 0, 5)).toBe(5);
    expect(sign(-0.1)).toBe(-1);
    expect(sign(0)).toBe(0);
    expect(roundTo(0.1 + 0.2, 6)).toBe(0.3);
    expect(toPp(0.005)).toBe(0.5);
    expect(toPp(0.02)).toBe(2);
    expect(isFiniteNumber(NaN)).toBe(false);
  });

  it('standard deviation', () => {
    expect(standardDeviation([1])).toBeNull();
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });
});

describe('format', () => {
  it('probabilities, with honest extremes and no NaN', () => {
    expect(formatProbability(0.624)).toBe('62.4%');
    expect(formatProbability(0.0004)).toBe('<0.1%');
    expect(formatProbability(0.9996)).toBe('>99.9%');
    expect(formatProbability(0)).toBe('0%');
    expect(formatProbability(1)).toBe('100%');
    expect(formatProbability(null)).toBe('—');
    expect(formatProbability(NaN)).toBe('—');
    expect(formatProbability(undefined)).toBe('—');
  });

  it('percentage point changes use a real minus sign and round before choosing the sign', () => {
    expect(formatPp(0.031)).toBe('+3.1 pp');
    expect(formatPp(-0.075)).toBe('−7.5 pp');
    expect(formatPp(0)).toBe('0.0 pp');
    expect(formatPp(-0.0004)).toBe('0.0 pp');
    expect(formatPp(0.031, { unit: false })).toBe('+3.1');
    expect(formatPp(Infinity)).toBe('—');
    expect(formatPpMagnitude(-0.031)).toBe('3.1 pp');
    expect(changeDirection(0.0004)).toBe('flat');
    expect(changeDirection(0.001)).toBe('up');
    expect(changeDirection(-0.02)).toBe('down');
    expect(changeDirection(null)).toBe('flat');
  });

  it('compact USD', () => {
    expect(formatUsd(845)).toBe('$845');
    expect(formatUsd(1150)).toBe('$1.15K');
    expect(formatUsd(12_400)).toBe('$12.4K');
    expect(formatUsd(245_120.44)).toBe('$245K');
    expect(formatUsd(999_999)).toBe('$1M');
    expect(formatUsd(1_184_233.55)).toBe('$1.18M');
    expect(formatUsd(48_200_000)).toBe('$48.2M');
    expect(formatUsd(2_500_000_000)).toBe('$2.5B');
    expect(formatUsd(-5)).toBe('—');
    expect(formatUsd(null)).toBe('—');
  });

  it('ratios, relative time, plurals', () => {
    expect(formatRatio(2.14)).toBe('2.1×');
    expect(formatRatio(12.4)).toBe('12×');
    expect(formatRatio(null)).toBe('—');
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 5_000, now)).toBe('just now');
    expect(relativeTime(now - 30_000, now)).toBe('30 s ago');
    expect(relativeTime(now - 10 * 60_000, now)).toBe('10 min ago');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 26 * 3600_000, now)).toBe('yesterday');
    expect(relativeTime(null, now)).toBe('—');
    expect(plural(1, 'outcome')).toBe('1 outcome');
    expect(plural(5, 'outcome')).toBe('5 outcomes');
  });
});
