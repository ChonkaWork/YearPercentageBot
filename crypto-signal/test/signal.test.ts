import { describe, expect, it } from 'vitest';
import {
  analyze,
  classify,
  classifyMacd,
  ENGINE_CONFIG,
  INDICATOR_KEYS,
  MAX_SCORE,
  scoreMacd,
  scoreRsi,
  signalStrength,
  volumeConfirmation,
  type Analysis,
} from '../src/core/signal';
import type { Candle } from '../src/core/types';
import { afterLast, candlesFromCloses, HOUR, walk } from './helpers';

/** 200 candles of a random walk; the last candle carries 2.4× the usual volume. */
function series(seed: number, drift: number): Candle[] {
  const closes = walk(200, { seed, drift, noise: 0.025 });
  return candlesFromCloses(closes, { volumes: closes.map((_, i) => (i === 199 ? 2400 : 1000)) });
}

function run(candles: Candle[], now = afterLast(candles)): Analysis {
  const outcome = analyze(candles, { now });
  if (!outcome.ok) throw new Error(`analysis failed: ${JSON.stringify(outcome)}`);
  return outcome.analysis;
}

function points(analysis: Analysis): Record<string, number> {
  return Object.fromEntries(INDICATOR_KEYS.map((key) => [key, analysis.indicators[key].points]));
}

/** Every number anywhere in the analysis is finite (no NaN / Infinity leaks into the UI). */
function expectAllFinite(value: unknown, path = 'analysis'): void {
  if (typeof value === 'number') expect(Number.isFinite(value), path).toBe(true);
  else if (Array.isArray(value)) value.forEach((item, i) => item !== null && expectAllFinite(item, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (v !== null) expectAllFinite(v, `${path}.${k}`);
}

describe('scoring rules', () => {
  it.each([
    [10, true, 2],
    [29.99, false, 2],
    [30, true, 1],
    [44.99, false, 1],
    [45, true, 0],
    [55, false, 0],
    [55.01, true, 0],
    [55.01, false, -1],
    [70, true, 0],
    [70, false, -1],
    [70.01, true, -2],
    [95, false, -2],
  ])('RSI %f (uptrend %s) → %i', (rsi, uptrend, expected) => {
    expect(scoreRsi(rsi, uptrend)).toBe(expected);
  });

  it('MACD states map to ±2 / ±1 / 0', () => {
    expect(scoreMacd('bullish-cross')).toBe(2);
    expect(scoreMacd('bullish')).toBe(1);
    expect(scoreMacd('neutral')).toBe(0);
    expect(scoreMacd('bearish')).toBe(-1);
    expect(scoreMacd('bearish-cross')).toBe(-2);
  });

  it.each([
    [8, 'STRONG_BULLISH'],
    [5, 'STRONG_BULLISH'],
    [4, 'BULLISH'],
    [2, 'BULLISH'],
    [1, 'NEUTRAL'],
    [0, 'NEUTRAL'],
    [-1, 'NEUTRAL'],
    [-2, 'BEARISH'],
    [-4, 'BEARISH'],
    [-5, 'STRONG_BEARISH'],
    [-8, 'STRONG_BEARISH'],
  ])('score %i → %s', (score, label) => {
    expect(classify(score)).toBe(label);
  });

  it('signal strength is |score| / 8 as a percentage, never more than 100', () => {
    expect(MAX_SCORE).toBe(8);
    expect(signalStrength(0)).toBe(0);
    expect(signalStrength(2)).toBe(25);
    expect(signalStrength(-5)).toBe(63);
    expect(signalStrength(8)).toBe(100);
    expect(signalStrength(12)).toBe(100);
    expect(signalStrength(Number.NaN)).toBe(0);
  });
});

describe('MACD crossover detection', () => {
  const price = 100;

  it('a sign change on the latest candle is a crossover 0 candles ago', () => {
    expect(classifyMacd([null, -0.5, -0.2, 0.3], price, 3)).toEqual({ state: 'bullish-cross', crossAgo: 0 });
    expect(classifyMacd([0.4, 0.2, -0.1], price, 3)).toEqual({ state: 'bearish-cross', crossAgo: 0 });
  });

  it('counts a crossover up to lookback − 1 candles back', () => {
    expect(classifyMacd([-0.5, -0.2, 0.1, 0.3, 0.4], price, 3)).toEqual({ state: 'bullish-cross', crossAgo: 2 });
    expect(classifyMacd([-0.5, -0.2, 0.1, 0.3, 0.4, 0.5], price, 3)).toEqual({ state: 'bullish', crossAgo: null });
  });

  it('a crossover that already reversed is just the current histogram sign', () => {
    expect(classifyMacd([-0.3, 0.2, -0.1], price, 3)).toEqual({ state: 'bearish-cross', crossAgo: 0 });
    expect(classifyMacd([-0.3, 0.2, -0.1, -0.2, -0.3], price, 3)).toEqual({ state: 'bearish-cross', crossAgo: 2 });
  });

  it('a histogram within float noise of zero is neutral', () => {
    const epsilon = price * ENGINE_CONFIG.macdNeutralFraction;
    expect(classifyMacd([0.5, epsilon / 2], price, 3)).toEqual({ state: 'neutral', crossAgo: null });
    expect(classifyMacd([null, null], price, 3)).toEqual({ state: 'neutral', crossAgo: null });
  });

  it('rising out of a flat histogram is a crossover', () => {
    expect(classifyMacd([0, 0, 0.2], price, 3)).toEqual({ state: 'bullish-cross', crossAgo: 0 });
  });
});

describe('volume confirmation', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);

  it('uses the last closed candle, not the one in progress', () => {
    const volumes = closes.map((_, i) => (i === 28 ? 3000 : i === 29 ? 10 : 1000));
    const candles = candlesFromCloses(closes, { volumes });
    const inProgress = candles[29]!.openTime + HOUR; // the last 4h candle is still open
    const volume = volumeConfirmation(candles, inProgress);
    expect(volume.ratio).toBeCloseTo(3, 10);
    expect(volume).toMatchObject({ candle: 'up', points: 1 });
    // Once the last candle has closed, its (tiny) volume is the one compared.
    expect(volumeConfirmation(candles, afterLast(candles))).toMatchObject({ points: 0 });
  });

  it('heavy volume on a down candle counts against a bullish read', () => {
    const down = [...closes.slice(0, 29), 90];
    const candles = candlesFromCloses(down, { volumes: down.map((_, i) => (i === 29 ? 2500 : 1000)) });
    expect(volumeConfirmation(candles, afterLast(candles))).toMatchObject({ candle: 'down', points: -1 });
  });

  it('zero volume everywhere gives no ratio and no points', () => {
    const candles = candlesFromCloses(closes, { volume: 0 });
    expect(volumeConfirmation(candles, afterLast(candles))).toEqual({ ratio: null, candle: 'up', points: 0 });
  });

  it('average volume or less adds nothing', () => {
    const candles = candlesFromCloses(closes, { volume: 1000 });
    expect(volumeConfirmation(candles, afterLast(candles))).toMatchObject({ ratio: 1, points: 0 });
  });
});

describe('analyze: representative series', () => {
  it('uptrend with a fresh MACD crossover and volume → STRONG BULLISH', () => {
    const analysis = run(series(1, 0.002));
    expect(analysis.signal).toBe('STRONG_BULLISH');
    expect(analysis.score).toBe(6);
    expect(analysis.strength).toBe(75);
    expect(points(analysis)).toEqual({ rsi: 0, macd: 2, priceVsEma50: 1, trend: 1, momentum: 1, volume: 1 });
    expect(analysis.indicators.rsi.zone).toBe('firm');
    expect(analysis.indicators.macd).toMatchObject({ state: 'bullish-cross', crossAgo: 0 });
    expect(analysis.indicators.volume.ratio).toBeCloseTo(2.4, 10);
  });

  it('steady uptrend with an overbought RSI → only BULLISH', () => {
    const analysis = run(series(4, 0.002));
    expect(analysis.signal).toBe('BULLISH');
    expect(analysis.indicators.rsi.zone).toBe('overbought');
    expect(analysis.indicators.rsi.points).toBe(-2);
    expect(analysis.score).toBe(3);
  });

  it('downtrend with a bearish MACD crossover → STRONG BEARISH', () => {
    const analysis = run(series(21, -0.002));
    expect(analysis.signal).toBe('STRONG_BEARISH');
    expect(analysis.score).toBe(-6);
    expect(points(analysis)).toEqual({ rsi: 0, macd: -2, priceVsEma50: -1, trend: -1, momentum: -1, volume: -1 });
  });

  it('downtrend with a soft RSI → BEARISH (the RSI point leans the other way)', () => {
    const analysis = run(series(19, -0.002));
    expect(analysis.signal).toBe('BEARISH');
    expect(analysis.score).toBe(-4);
    expect(analysis.indicators.rsi).toMatchObject({ zone: 'weak', points: 1 });
  });

  it('sideways market with mixed readings → NEUTRAL', () => {
    const analysis = run(series(3, 0));
    expect(analysis.signal).toBe('NEUTRAL');
    expect(analysis.score).toBe(0);
    expect(analysis.strength).toBe(0);
    const values = Object.values(points(analysis));
    expect(values.some((p) => p > 0) && values.some((p) => p < 0)).toBe(true);
  });

  it('RSI 55–70 costs a point without an uptrend, nothing within one', () => {
    const analysis = run(series(3, 0));
    expect(analysis.indicators.rsi.zone).toBe('firm');
    expect(analysis.indicators.trend.state).toBe('down');
    expect(analysis.indicators.rsi.points).toBe(-1);
    const bullish = run(series(1, 0.002));
    expect(bullish.indicators.rsi.zone).toBe('firm');
    expect(bullish.indicators.rsi.points).toBe(0);
  });

  it('the score is the sum of the indicator points, and every number is finite', () => {
    for (const [seed, drift] of [[1, 0.002], [21, -0.002], [3, 0], [14, 0]] as const) {
      const analysis = run(series(seed, drift));
      expect(analysis.score).toBe(Object.values(points(analysis)).reduce((a, b) => a + b, 0));
      expect(analysis.maxScore).toBe(MAX_SCORE);
      expectAllFinite(analysis);
    }
  });

  it('keeps the last 60 candles for the chart with aligned EMAs', () => {
    const analysis = run(series(1, 0.002));
    expect(analysis.chart.close).toHaveLength(ENGINE_CONFIG.chartPoints);
    expect(analysis.chart.ema20).toHaveLength(ENGINE_CONFIG.chartPoints);
    expect(analysis.chart.time).toHaveLength(ENGINE_CONFIG.chartPoints);
    expect(analysis.chart.close.at(-1)).toBe(analysis.price);
    expect(analysis.chart.ema50.at(-1)).toBeCloseTo(analysis.indicators.trend.ema50, 10);
  });
});

describe('analyze: edge cases', () => {
  it('too few candles is reported, not guessed', () => {
    const candles = candlesFromCloses(walk(59, { seed: 1, drift: 0, noise: 0.02 }));
    expect(analyze(candles, { now: afterLast(candles) })).toEqual({ ok: false, reason: 'insufficient-data', needed: 60, got: 59 });
    expect(analyze([], { now: 0 })).toMatchObject({ ok: false, reason: 'insufficient-data', got: 0 });
  });

  it('exactly the minimum works, with the early EMA50 chart points empty', () => {
    const candles = candlesFromCloses(walk(60, { seed: 2, drift: 0.001, noise: 0.02 }));
    const analysis = run(candles);
    // EMA50 needs 50 closes: the first 49 chart points have none.
    expect(analysis.chart.ema50.slice(0, 49).every((value) => value === null)).toBe(true);
    expect(analysis.chart.ema50[49]).not.toBeNull();
  });

  it('flat prices → NEUTRAL with 0% strength', () => {
    const candles = candlesFromCloses(Array.from({ length: 120 }, () => 50));
    const analysis = run(candles);
    expect(analysis.signal).toBe('NEUTRAL');
    expect(analysis.score).toBe(0);
    expect(analysis.strength).toBe(0);
    expect(analysis.indicators.rsi.value).toBe(50);
    expect(analysis.indicators.macd.state).toBe('neutral');
    expect(analysis.indicators.trend.state).toBe('flat');
    expect(analysis.indicators.momentum.state).toBe('flat');
    expect(analysis.indicators.priceVsEma50.distancePct).toBe(0);
    expectAllFinite(analysis);
  });

  it('zero volume is fine: volume just adds nothing', () => {
    const candles = candlesFromCloses(walk(120, { seed: 1, drift: 0.002, noise: 0.025 }), { volume: 0 });
    const analysis = run(candles);
    expect(analysis.indicators.volume).toEqual({ ratio: null, candle: expect.any(String), points: 0 });
    expectAllFinite(analysis);
  });

  it.each([
    ['NaN close', (c: Candle) => ({ ...c, close: Number.NaN })],
    ['Infinity volume', (c: Candle) => ({ ...c, volume: Number.POSITIVE_INFINITY })],
    ['negative price', (c: Candle) => ({ ...c, low: -1 })],
    ['zero price', (c: Candle) => ({ ...c, open: 0, low: 0 })],
    ['negative volume', (c: Candle) => ({ ...c, volume: -5 })],
    ['high below close', (c: Candle) => ({ ...c, high: c.close / 2 })],
    ['string value', (c: Candle) => ({ ...c, close: '42' as unknown as number })],
  ])('rejects candles with a %s', (_name, corrupt) => {
    const candles = candlesFromCloses(walk(100, { seed: 5, drift: 0, noise: 0.02 }));
    candles[70] = corrupt(candles[70]!);
    const outcome = analyze(candles, { now: afterLast(candles) });
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-data' });
  });

  it('rejects candles out of order or duplicated', () => {
    const candles = candlesFromCloses(walk(100, { seed: 5, drift: 0, noise: 0.02 }));
    const swapped = [...candles];
    [swapped[10], swapped[11]] = [swapped[11]!, swapped[10]!];
    expect(analyze(swapped, { now: afterLast(candles) })).toMatchObject({ ok: false, reason: 'invalid-data' });
    const duplicated = [...candles.slice(0, 50), candles[49]!, ...candles.slice(50)];
    expect(analyze(duplicated, { now: afterLast(candles) })).toMatchObject({ ok: false, reason: 'invalid-data' });
  });
});
