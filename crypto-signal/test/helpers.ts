import type { Candle } from '../src/core/types';

export const HOUR = 60 * 60 * 1000;
/** A fixed, candle-aligned start time (2026-01-01T00:00:00Z). */
export const T0 = Date.UTC(2026, 0, 1);

/** Deterministic PRNG (mulberry32), so "random" series are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random walk with drift: each close = previous × (1 + drift + noise·(r − 0.5)). */
export function walk(length: number, options: { seed: number; start?: number; drift: number; noise: number }): number[] {
  const random = rng(options.seed);
  const closes = [options.start ?? 100];
  for (let i = 1; i < length; i++) {
    closes.push(closes[i - 1]! * (1 + options.drift + options.noise * (random() - 0.5)));
  }
  return closes;
}

/** Candles whose open is the previous close, with a small wick on both sides. */
export function candlesFromCloses(
  closes: readonly number[],
  options: { interval?: number; start?: number; volumes?: readonly number[]; volume?: number } = {},
): Candle[] {
  const interval = options.interval ?? 4 * HOUR;
  const start = options.start ?? T0;
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    const openTime = start + i * interval;
    return {
      openTime,
      closeTime: openTime + interval,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: options.volumes?.[i] ?? options.volume ?? 1000,
    };
  });
}

/** "now" just after the last candle closed: every candle counts as closed. */
export function afterLast(candles: readonly Candle[]): number {
  return candles[candles.length - 1]!.closeTime + 1;
}
