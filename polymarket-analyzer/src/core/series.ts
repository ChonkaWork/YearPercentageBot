import { isFiniteNumber, toPp } from './numbers';
import { HOUR_MS, type PricePoint } from './types';

/**
 * Price series helpers. A series is a list of {t (ms), p (0..1)} points; after
 * `cleanSeries` it is sorted by time, without duplicates or invalid points.
 */

export function cleanSeries(points: readonly PricePoint[]): PricePoint[] {
  const valid = points.filter((point) => isFiniteNumber(point.t) && isFiniteNumber(point.p) && point.p >= 0 && point.p <= 1 && point.t > 0);
  valid.sort((a, b) => a.t - b.t);
  const result: PricePoint[] = [];
  for (const point of valid) {
    const last = result[result.length - 1];
    // Same timestamp twice: keep the later entry.
    if (last && last.t === point.t) result[result.length - 1] = { t: point.t, p: point.p };
    else result.push({ t: point.t, p: point.p });
  }
  return result;
}

/** Last known price at or before `t`, or null when the series starts after `t`. */
export function valueAt(series: readonly PricePoint[], t: number): number | null {
  let low = 0;
  let high = series.length - 1;
  let found: number | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const point = series[middle]!;
    if (point.t <= t) {
      found = point.p;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Price change over the window that ends at the last point. Null when the series doesn't
 * reach back far enough (allowing 10% slack, so hourly data can cover exactly 24 h).
 */
export function changeOverWindow(series: readonly PricePoint[], windowMs: number): number | null {
  const last = series[series.length - 1];
  const first = series[0];
  if (!last || !first || series.length < 2) return null;
  const start = last.t - windowMs;
  if (first.t > start + windowMs * 0.1) return null;
  const startValue = valueAt(series, start) ?? first.p;
  return last.p - startValue;
}

/** Forward-filled prices on a regular grid from the first to the last point. */
export function resample(series: readonly PricePoint[], stepMs: number): PricePoint[] {
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last || stepMs <= 0) return [];
  const result: PricePoint[] = [];
  let index = 0;
  let current = first.p;
  for (let t = first.t; t <= last.t; t += stepMs) {
    while (index < series.length && series[index]!.t <= t) {
      current = series[index]!.p;
      index++;
    }
    result.push({ t, p: current });
  }
  if (result[result.length - 1]!.t !== last.t) result.push({ t: last.t, p: last.p });
  return result;
}

/** Hourly price changes in percentage points. */
export function hourlyChangesPp(series: readonly PricePoint[]): number[] {
  const grid = resample(series, HOUR_MS);
  const changes: number[] = [];
  for (let index = 1; index < grid.length; index++) {
    // The final grid step can be shorter than an hour; skip it unless it is most of an hour.
    const step = grid[index]!.t - grid[index - 1]!.t;
    if (step < HOUR_MS * 0.5) continue;
    changes.push(toPp(grid[index]!.p - grid[index - 1]!.p));
  }
  return changes;
}

/** Only the points in the last `windowMs` (relative to the last point). */
export function tail(series: readonly PricePoint[], windowMs: number): PricePoint[] {
  const last = series[series.length - 1];
  if (!last) return [];
  return series.filter((point) => point.t >= last.t - windowMs);
}

export interface SignificantMove {
  /** Time and price at the end of the move. */
  t: number;
  p: number;
  /** Change over the move window in probability units. */
  change: number;
}

/**
 * The largest price moves in a series: points where the price differs from the price
 * `windowMs` earlier by at least `thresholdPp`. Markers are at least one window apart and
 * the strongest ones win. Used to mark the chart.
 */
export function significantMoves(
  series: readonly PricePoint[],
  windowMs: number,
  thresholdPp: number,
  maxMoves = 3,
): SignificantMove[] {
  const first = series[0];
  if (!first) return [];
  const candidates: SignificantMove[] = [];
  for (const point of series) {
    if (point.t - windowMs < first.t) continue;
    const before = valueAt(series, point.t - windowMs);
    if (before === null) continue;
    const change = point.p - before;
    if (Math.abs(toPp(change)) >= thresholdPp) candidates.push({ t: point.t, p: point.p, change });
  }
  candidates.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || b.t - a.t);
  const chosen: SignificantMove[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= maxMoves) break;
    if (chosen.some((move) => Math.abs(move.t - candidate.t) < windowMs)) continue;
    chosen.push(candidate);
  }
  return chosen.sort((a, b) => a.t - b.t);
}

/** At most `maxPoints` points, evenly spaced by index, always keeping the first and last. */
export function downsample(series: readonly PricePoint[], maxPoints: number): PricePoint[] {
  if (series.length <= maxPoints || maxPoints < 2) return series.slice();
  const result: PricePoint[] = [];
  const step = (series.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index++) result.push(series[Math.round(index * step)]!);
  return result;
}

/** Largest absolute single-hour change within the last `windowMs`, in probability units (signed). */
export function largestHourlyMove(series: readonly PricePoint[], windowMs: number): number | null {
  const recent = tail(series, windowMs + HOUR_MS);
  const grid = resample(recent, HOUR_MS);
  let best: number | null = null;
  for (let index = 1; index < grid.length; index++) {
    const change = grid[index]!.p - grid[index - 1]!.p;
    if (best === null || Math.abs(change) > Math.abs(best)) best = change;
  }
  return best;
}
