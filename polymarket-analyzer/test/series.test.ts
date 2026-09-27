import { describe, expect, it } from 'vitest';
import { changeOverWindow, cleanSeries, downsample, hourlyChangesPp, largestHourlyMove, resample, significantMoves, tail, valueAt } from '../src/core/series';
import { DAY_MS, HOUR_MS } from '../src/core/types';
import { FIXTURE_NOW_MS, hourlySeries } from './helpers';

describe('price series', () => {
  it('cleans: sorts, drops invalid points, keeps the later of duplicate timestamps', () => {
    const series = cleanSeries([
      { t: 3000, p: 0.3 },
      { t: 1000, p: 0.1 },
      { t: 2000, p: NaN },
      { t: 2000, p: 1.5 },
      { t: 3000, p: 0.35 },
      { t: -5, p: 0.2 },
      { t: 4000, p: 0.4 },
    ]);
    expect(series).toEqual([
      { t: 1000, p: 0.1 },
      { t: 3000, p: 0.35 },
      { t: 4000, p: 0.4 },
    ]);
  });

  it('valueAt returns the last price at or before a time', () => {
    const series = [
      { t: 10, p: 0.1 },
      { t: 20, p: 0.2 },
      { t: 30, p: 0.3 },
    ];
    expect(valueAt(series, 5)).toBeNull();
    expect(valueAt(series, 10)).toBe(0.1);
    expect(valueAt(series, 25)).toBe(0.2);
    expect(valueAt(series, 99)).toBe(0.3);
  });

  it('change over a window needs enough coverage', () => {
    const week = hourlySeries(168, (hoursAgo) => 0.5 + (168 - hoursAgo) * 0.0005);
    expect(changeOverWindow(week, DAY_MS)).toBeCloseTo(0.012, 6);
    expect(changeOverWindow(week, 7 * DAY_MS)).toBeCloseTo(0.084, 6);
    const halfDay = hourlySeries(12, () => 0.5);
    expect(changeOverWindow(halfDay, DAY_MS)).toBeNull();
    expect(changeOverWindow([{ t: 1, p: 0.5 }], DAY_MS)).toBeNull();
  });

  it('resamples to a forward-filled grid and measures hourly changes', () => {
    const series = [
      { t: 0, p: 0.5 },
      { t: 90 * 60_000, p: 0.6 },
      { t: 3 * HOUR_MS, p: 0.55 },
    ];
    expect(resample(series, HOUR_MS).map((point) => point.p)).toEqual([0.5, 0.5, 0.6, 0.55]);
    expect(hourlyChangesPp(series)).toEqual([0, 10, -5]);
  });

  it('finds significant moves, at most one per window, strongest first', () => {
    const series = hourlySeries(48, (hoursAgo) => (hoursAgo <= 30 ? 0.6 : 0.5) + (hoursAgo <= 5 ? -0.08 : 0));
    const moves = significantMoves(series, 6 * HOUR_MS, 4, 3);
    expect(moves).toHaveLength(2);
    expect(moves[0]!.change).toBeCloseTo(0.1, 6);
    expect(moves[1]!.change).toBeCloseTo(-0.08, 6);
    expect(moves[1]!.t - moves[0]!.t).toBeGreaterThanOrEqual(6 * HOUR_MS);
    expect(significantMoves(series, 6 * HOUR_MS, 20)).toEqual([]);
  });

  it('downsamples keeping the ends', () => {
    const series = hourlySeries(168, (hoursAgo) => hoursAgo / 1000);
    const small = downsample(series, 20);
    expect(small).toHaveLength(20);
    expect(small[0]).toEqual(series[0]);
    expect(small[19]).toEqual(series[168]);
    expect(downsample(series.slice(0, 5), 20)).toHaveLength(5);
  });

  it('largest hourly move in the last day and tail()', () => {
    const series = hourlySeries(168, (hoursAgo) => (hoursAgo <= 5 ? 0.68 : 0.6));
    expect(largestHourlyMove(series, DAY_MS)).toBeCloseTo(0.08, 6);
    expect(tail(series, DAY_MS)[0]!.t).toBe(FIXTURE_NOW_MS - DAY_MS);
  });
});
