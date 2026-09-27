/**
 * Technical indicators over plain number arrays. Pure functions, no I/O.
 *
 * Every function returns a series aligned with its input: index i of the output belongs to
 * index i of the input, and positions without enough history are `null` (never NaN).
 */

export type Series = (number | null)[];

function emptySeries(length: number): Series {
  return Array.from({ length }, () => null);
}

/** Simple moving average. */
export function sma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out = emptySeries(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values
 * (the common charting convention), smoothing factor 2 / (period + 1).
 */
export function ema(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out = emptySeries(values.length);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let previous = seed / period;
  out[period - 1] = previous;
  for (let i = period; i < values.length; i++) {
    previous = values[i]! * k + previous * (1 - k);
    out[i] = previous;
  }
  return out;
}

/** EMA over a series that starts with nulls (e.g. the MACD line). */
function emaOfSeries(values: Series, period: number): Series {
  const start = values.findIndex((value) => value !== null);
  const out = emptySeries(values.length);
  if (start < 0) return out;
  const tail = values.slice(start) as number[];
  const smoothed = ema(tail, period);
  for (let i = 0; i < smoothed.length; i++) out[start + i] = smoothed[i]!;
  return out;
}

/**
 * Relative Strength Index with Wilder's smoothing.
 *
 * The first average gain/loss is the simple mean of the first `period` changes, then
 * avg = (previous * (period - 1) + current) / period. When there were no losses the RSI is
 * 100, when there were neither gains nor losses (flat prices) it is 50.
 */
export function rsi(closes: readonly number[], period = 14): Series {
  assertPeriod(period);
  const out = emptySeries(closes.length);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFrom(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface MacdSeries {
  macd: Series;
  signal: Series;
  histogram: Series;
}

/** MACD line (EMA fast − EMA slow), its signal line (EMA of the MACD line) and the histogram. */
export function macd(closes: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  if (fast >= slow) throw new RangeError('MACD fast period must be shorter than the slow period');
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line: Series = closes.map((_, i) => {
    const f = fastEma[i];
    const s = slowEma[i];
    return f === null || f === undefined || s === null || s === undefined ? null : f - s;
  });
  const signal = emaOfSeries(line, signalPeriod);
  const histogram: Series = line.map((value, i) => {
    const sig = signal[i];
    return value === null || sig === null || sig === undefined ? null : value - sig;
  });
  return { macd: line, signal, histogram };
}

/** Percent change between the last value and the value `period` steps earlier. Null without enough data. */
export function rateOfChange(values: readonly number[], period: number): number | null {
  assertPeriod(period);
  if (values.length <= period) return null;
  const last = values[values.length - 1]!;
  const base = values[values.length - 1 - period]!;
  if (base === 0) return null;
  return ((last - base) / base) * 100;
}

/** Last non-null value of a series. */
export function lastValue(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`Invalid period: ${period}`);
}
