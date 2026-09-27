import { describe, expect, it } from 'vitest';
import { classifyLiquidity, measureVolatility, volumeActivity } from '../src/core/metrics';
import { changeScore, computeMomentum, labelForScore, trendAdjustment, type MomentumInput } from '../src/core/momentum';
import { detectUnusualActivity, type UnusualInput } from '../src/core/unusual';
import { DAY_MS } from '../src/core/types';
import { hourlySeries } from './helpers';

describe('liquidity', () => {
  it('uses documented thresholds', () => {
    expect(classifyLiquidity(9_999.99)).toBe('LOW');
    expect(classifyLiquidity(10_000)).toBe('MEDIUM');
    expect(classifyLiquidity(99_999)).toBe('MEDIUM');
    expect(classifyLiquidity(100_000)).toBe('HIGH');
    expect(classifyLiquidity(null)).toBe('UNKNOWN');
    expect(classifyLiquidity(-1)).toBe('UNKNOWN');
  });
});

describe('volume activity', () => {
  it('compares 24h volume to the 7-day daily average', () => {
    expect(volumeActivity({ volume24h: 5_000, volume7d: 70_000 })).toMatchObject({ level: 'NORMAL', ratio: 0.5 });
    expect(volumeActivity({ volume24h: 3_000, volume7d: 70_000 }).level).toBe('LOW');
    expect(volumeActivity({ volume24h: 10_000, volume7d: 70_000 })).toMatchObject({ level: 'NORMAL', ratio: 1, averageDaily: 10_000 });
    expect(volumeActivity({ volume24h: 15_000, volume7d: 70_000 }).level).toBe('HIGH');
    expect(volumeActivity({ volume24h: 30_000, volume7d: 70_000 }).level).toBe('VERY_HIGH');
  });

  it('averages young markets over the days they have existed', () => {
    const young = volumeActivity({ volume24h: 10_000, volume7d: 20_000, marketAgeMs: 2 * DAY_MS });
    expect(young.averageDaily).toBe(10_000);
    expect(young.level).toBe('NORMAL');
  });

  it('handles inconsistent, zero and missing volume', () => {
    // 7-day figure lagging behind the 24h one: the week has at least that day's volume.
    expect(volumeActivity({ volume24h: 7_000, volume7d: 1_000 }).ratio).toBe(7);
    expect(volumeActivity({ volume24h: 0, volume7d: 0 })).toMatchObject({ level: 'LOW', ratio: null });
    expect(volumeActivity({ volume24h: null, volume7d: 1_000 }).level).toBe('UNKNOWN');
    expect(volumeActivity({ volume24h: 1_000, volume7d: NaN }).level).toBe('UNKNOWN');
  });
});

describe('volatility', () => {
  it('is NORMAL for calm prices, EXTREME for big hourly swings, UNKNOWN without data', () => {
    expect(measureVolatility(hourlySeries(168, (h) => 0.5 + (h % 2) * 0.002)).level).toBe('NORMAL');
    expect(measureVolatility(hourlySeries(168, (h) => 0.5 + (h % 2) * 0.03)).level).toBe('EXTREME');
    expect(measureVolatility(hourlySeries(168, (h) => 0.5 + (h % 2) * 0.008)).level).toBe('ELEVATED');
    expect(measureVolatility(hourlySeries(6, () => 0.5)).level).toBe('UNKNOWN');
    expect(measureVolatility(null)).toEqual({ level: 'UNKNOWN', hourlyPp: null });
  });
});

describe('momentum score table', () => {
  it.each([
    [5.01, 3],
    [5, 2],
    [2, 2],
    [1.99, 1],
    [0.5, 1],
    [0.49, 0],
    [0, 0],
    [-0.49, 0],
    [-0.5, -1],
    [-1.99, -1],
    [-2, -2],
    [-5, -2],
    [-5.01, -3],
    [-40, -3],
  ])('24h change %s pp scores %s', (pp, score) => {
    expect(changeScore(pp)).toBe(score);
  });

  it('7d trend adds or subtracts one outside a 0.5 pp dead band', () => {
    expect(trendAdjustment(0.6)).toBe(1);
    expect(trendAdjustment(0.5)).toBe(0);
    expect(trendAdjustment(-0.6)).toBe(-1);
    expect(trendAdjustment(null)).toBe(0);
  });

  it('labels', () => {
    expect([5, 4, 3, 1, 0, -1, -3, -4, -5].map(labelForScore)).toEqual([
      'STRONG_POSITIVE',
      'STRONG_POSITIVE',
      'POSITIVE',
      'POSITIVE',
      'NEUTRAL',
      'NEGATIVE',
      'NEGATIVE',
      'STRONG_NEGATIVE',
      'STRONG_NEGATIVE',
    ]);
  });
});

describe('computeMomentum', () => {
  const base: MomentumInput = { change24h: 0.03, change7d: 0.05, volume: 'NORMAL', liquidity: 'HIGH', volatility: 'NORMAL' };

  it('positive: +3 pp / +5 pp on normal volume and deep liquidity', () => {
    expect(computeMomentum(base)).toMatchObject({ label: 'POSITIVE', score: 3, strength: 60 });
  });

  it('volume strengthens in the direction of the move and never flips it', () => {
    expect(computeMomentum({ ...base, volume: 'HIGH' })).toMatchObject({ label: 'STRONG_POSITIVE', score: 4, strength: 80 });
    expect(computeMomentum({ ...base, change24h: -0.03, change7d: -0.05, volume: 'VERY_HIGH' })).toMatchObject({ label: 'STRONG_NEGATIVE', score: -4 });
    expect(computeMomentum({ ...base, change24h: 0.001, change7d: 0.001, volume: 'VERY_HIGH' })).toMatchObject({ label: 'NEUTRAL', score: 0, strength: 0 });
  });

  it('caps at ±5 → 100', () => {
    expect(computeMomentum({ ...base, change24h: 0.2, change7d: 0.3, volume: 'VERY_HIGH' })).toMatchObject({ score: 5, strength: 100 });
  });

  it('liquidity scales confidence, extreme volatility and low volume reduce strength', () => {
    expect(computeMomentum({ ...base, liquidity: 'LOW' }).strength).toBe(36);
    expect(computeMomentum({ ...base, liquidity: 'MEDIUM' }).strength).toBe(51);
    expect(computeMomentum({ ...base, liquidity: 'UNKNOWN' }).strength).toBe(42);
    expect(computeMomentum({ ...base, volatility: 'EXTREME' }).strength).toBe(39);
    expect(computeMomentum({ ...base, volatility: 'ELEVATED' }).strength).toBe(51);
    expect(computeMomentum({ ...base, volume: 'LOW' }).strength).toBe(51);
    // Labels don't depend on liquidity or volatility.
    expect(computeMomentum({ ...base, liquidity: 'LOW', volatility: 'EXTREME' }).label).toBe('POSITIVE');
  });

  it('a 24h move against the 7d trend is weakened', () => {
    expect(computeMomentum({ ...base, change24h: 0.03, change7d: -0.04 })).toMatchObject({ label: 'POSITIVE', score: 1, strength: 20 });
  });

  it('needs the 24h change; the 7d change is optional', () => {
    expect(computeMomentum({ ...base, change24h: null })).toEqual({ label: null, score: null, strength: null, components: null });
    expect(computeMomentum({ ...base, change7d: null })).toMatchObject({ label: 'POSITIVE', score: 2 });
  });
});

describe('unusual activity', () => {
  const calm: UnusualInput = {
    change24h: 0.01,
    change7d: 0.02,
    volume: { level: 'NORMAL', ratio: 1.1, averageDaily: 10_000, volume24h: 11_000 },
    liquidity: { level: 'HIGH', usd: 500_000 },
    largestHourlyMove: 0.004,
  };
  const kinds = (input: UnusualInput) => detectUnusualActivity(input).map((signal) => signal.kind);

  it('nothing for a calm market', () => {
    expect(detectUnusualActivity(calm)).toEqual([]);
  });

  it('large move and volume spike on their own', () => {
    expect(kinds({ ...calm, change24h: -0.12, change7d: -0.15 })).toEqual(['LARGE_MOVE']);
    expect(kinds({ ...calm, volume: { level: 'VERY_HIGH', ratio: 3.4, averageDaily: 10_000, volume24h: 34_000 } })).toEqual(['VOLUME_SPIKE']);
  });

  it('move + spike replaces the two separate flags', () => {
    const signals = detectUnusualActivity({ ...calm, change24h: 0.124, change7d: 0.2, volume: { level: 'VERY_HIGH', ratio: 4, averageDaily: 130_000, volume24h: 520_000 } });
    expect(signals.map((signal) => signal.kind)).toEqual(['MOVE_WITH_SPIKE']);
    expect(signals[0]!.detail).toBe('+12.4 pp in 24h on 4.0× the average daily volume.');
  });

  it('sudden reversal against the previous 6 days', () => {
    const signals = detectUnusualActivity({ ...calm, change24h: 0.05, change7d: 0.01 });
    expect(signals.map((signal) => signal.kind)).toContain('REVERSAL');
    expect(signals.find((signal) => signal.kind === 'REVERSAL')!.detail).toBe('+5.0 pp in 24h after −4.0 pp over the previous 6 days.');
    expect(kinds({ ...calm, change24h: 0.05, change7d: 0.07 })).not.toContain('REVERSAL');
  });

  it('sudden hourly move from history', () => {
    expect(kinds({ ...calm, largestHourlyMove: -0.06 })).toEqual(['SUDDEN_MOVE']);
    expect(kinds({ ...calm, largestHourlyMove: null })).toEqual([]);
  });

  it('large move with low liquidity', () => {
    const signals = detectUnusualActivity({ ...calm, change24h: 0.06, change7d: 0.08, liquidity: { level: 'LOW', usd: 4_200 } });
    expect(signals.map((signal) => signal.kind)).toEqual(['LOW_LIQUIDITY_MOVE']);
    expect(signals[0]!.detail).toBe('+6.0 pp in 24h with only $4.2K of liquidity.');
  });

  it('never speculates about causes', () => {
    const all = detectUnusualActivity({
      change24h: 0.15,
      change7d: 0.02,
      volume: { level: 'VERY_HIGH', ratio: 5, averageDaily: 1_000, volume24h: 5_000 },
      liquidity: { level: 'LOW', usd: 2_000 },
      largestHourlyMove: 0.1,
    });
    expect(all.length).toBeGreaterThan(2);
    for (const signal of all) expect(`${signal.title} ${signal.detail}`).not.toMatch(/news|insider|whale|because|manipulat|rumou?r/i);
  });
});
