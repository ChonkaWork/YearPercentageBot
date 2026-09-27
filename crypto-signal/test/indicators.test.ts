import { describe, expect, it } from 'vitest';
import { ema, lastValue, macd, rateOfChange, rsi, sma } from '../src/core/indicators';

// Wilder RSI reference data (StockCharts "RSI" ChartSchool spreadsheet). The spreadsheet rounds
// its running averages to two decimals, so full-precision results differ by up to ~0.07; the
// first value at full precision is 70.464 (the value TA-Lib reports).
const RSI_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41,
  46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];
const RSI_EXPECTED = [
  70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.3, 33.08, 37.77,
];

describe('sma / ema', () => {
  it('sma averages a sliding window and leaves the warm-up empty', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('ema is seeded with the SMA and lags a linear series by (period − 1) / 2 steps', () => {
    const values = Array.from({ length: 30 }, (_, i) => 10 + 2 * i);
    const out = ema(values, 5);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
    for (let i = 4; i < values.length; i++) expect(out[i]).toBeCloseTo(values[i]! - 2 * 2, 10);
  });

  it('returns only nulls when there is not enough data', () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });

  it('rejects invalid periods', () => {
    expect(() => ema([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => sma([1, 2, 3], 1.5)).toThrow(RangeError);
  });
});

describe('rsi (Wilder)', () => {
  it('matches the published reference values', () => {
    const out = rsi(RSI_CLOSES, 14);
    expect(out.slice(0, 14).every((value) => value === null)).toBe(true);
    const computed = out.slice(14) as number[];
    expect(computed).toHaveLength(RSI_EXPECTED.length);
    expect(computed[0]).toBeCloseTo(70.464, 3);
    computed.forEach((value, i) => expect(Math.abs(value - RSI_EXPECTED[i]!)).toBeLessThan(0.1));
  });

  it('is 100 with only gains, 0 with only losses and 50 when flat', () => {
    expect(lastValue(rsi(Array.from({ length: 30 }, (_, i) => 100 + i)))).toBe(100);
    expect(lastValue(rsi(Array.from({ length: 30 }, (_, i) => 100 - i)))).toBe(0);
    expect(lastValue(rsi(Array.from({ length: 30 }, () => 100)))).toBe(50);
  });
});

describe('macd', () => {
  it('is a constant 7 × slope on a linear series, with a zero histogram', () => {
    const slope = 3;
    const values = Array.from({ length: 80 }, (_, i) => 1000 + slope * i);
    const { macd: line, signal, histogram } = macd(values);
    expect(line[24]).toBeNull();
    expect(line[25]).toBeCloseTo(7 * slope, 9);
    expect(signal[32]).toBeNull();
    expect(signal[33]).toBeCloseTo(7 * slope, 9);
    expect(lastValue(histogram)).toBeCloseTo(0, 9);
  });

  it('histogram turns positive when a decline reverses upward', () => {
    const values = [...Array.from({ length: 60 }, (_, i) => 200 - i), ...Array.from({ length: 15 }, (_, i) => 141 + 3 * i)];
    const { histogram } = macd(values);
    expect(histogram[59]!).toBeCloseTo(0, 9);
    expect(lastValue(histogram)!).toBeGreaterThan(0);
  });

  it('rejects fast ≥ slow', () => {
    expect(() => macd([1, 2, 3], 26, 12)).toThrow(RangeError);
  });
});

describe('rateOfChange', () => {
  it('is the percent change over the period', () => {
    expect(rateOfChange([100, 101, 102, 110], 3)).toBeCloseTo(10, 10);
    expect(rateOfChange([100, 90], 1)).toBeCloseTo(-10, 10);
  });

  it('is null without enough data or from a zero base', () => {
    expect(rateOfChange([1, 2], 2)).toBeNull();
    expect(rateOfChange([0, 5], 1)).toBeNull();
  });
});
