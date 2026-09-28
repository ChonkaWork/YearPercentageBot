import { findPrice, type Price } from './numbers';
import type { ChangeMode } from './types';

/**
 * Value history of number and price watches: the value is recorded on every check, so the
 * popup can show where it's going and the "lowest in 30 days" rule has something to compare with.
 */

export interface ValuePoint {
  /** When it was checked. */
  t: number;
  v: number;
  /** As written on the page: "$1,299.00". */
  r: string;
}

/** Points kept per watch (the oldest are dropped). Runs of the same value keep only their ends. */
export const MAX_POINTS = 500;
export const LOWEST_DAYS = 30;
/** The free plan's chart shows this many days; Pro shows the full history. */
export const FREE_HISTORY_DAYS = 7;
export const DAY_MS = 86_400_000;
/** A picked region this short with a number in it is followed as a value even under "any change". */
const SHORT_VALUE_CHARS = 60;

/** The value a watch follows: the first price, or the first number when there's no price. */
export function readValue(text: string): Price | null {
  return findPrice(text, null);
}

/** Rules about a value: they always record its history. */
export function isValueMode(mode: ChangeMode): boolean {
  return mode === 'number' || mode === 'below' || mode === 'lowest';
}

/** Number and price watches: a value rule, or a picked element that is just a short value ("$129.00"). */
export function tracksValue(watch: { mode: ChangeMode; selector: string | null }, text: string): boolean {
  if (isValueMode(watch.mode)) return true;
  return watch.selector !== null && text.length <= SHORT_VALUE_CHARS && !text.includes('\n') && readValue(text) !== null;
}

/** Adds a check's value. A value that stays the same only moves the end of its run forward. */
export function recordValue(points: readonly ValuePoint[], point: ValuePoint, max = MAX_POINTS): ValuePoint[] {
  const last = points[points.length - 1];
  const beforeLast = points[points.length - 2];
  if (last && beforeLast && last.v === point.v && beforeLast.v === point.v) return [...points.slice(0, -1), point];
  const next = [...points, point];
  return next.length > max ? next.slice(next.length - max) : next;
}

export interface Trend {
  current: ValuePoint;
  /** The last different value before it, if any. */
  previous: ValuePoint | null;
  direction: 'up' | 'down' | 'same';
}

export function trend(points: readonly ValuePoint[]): Trend | null {
  const current = points[points.length - 1];
  if (!current) return null;
  for (let i = points.length - 2; i >= 0; i--) {
    const point = points[i]!;
    if (point.v !== current.v) return { current, previous: point, direction: current.v < point.v ? 'down' : 'up' };
  }
  return { current, previous: null, direction: 'same' };
}

/** The lowest value checked since `since` (the latest one when tied), or null. */
export function lowestSince(points: readonly ValuePoint[], since: number): ValuePoint | null {
  let lowest: ValuePoint | null = null;
  for (const point of points) {
    if (point.t >= since && (!lowest || point.v <= lowest.v)) lowest = point;
  }
  return lowest;
}

export function highestSince(points: readonly ValuePoint[], since: number): ValuePoint | null {
  let highest: ValuePoint | null = null;
  for (const point of points) {
    if (point.t >= since && (!highest || point.v >= highest.v)) highest = point;
  }
  return highest;
}

export interface NewLow {
  /** The lowest value before this one in the window. */
  previousLow: ValuePoint;
  /** The first check in the window: less than `days` ago means the history is shorter than that. */
  since: number;
  /** The history covers the whole window. */
  fullWindow: boolean;
}

/**
 * Is `value` lower than everything checked in the last `days` days? Needs at least one earlier
 * check in the window. Equal to the low isn't a new low.
 */
export function newLow(points: readonly ValuePoint[], value: number, now: number, days = LOWEST_DAYS): NewLow | null {
  const windowStart = now - days * DAY_MS;
  const low = lowestSince(points, windowStart);
  if (!low || value >= low.v) return null;
  const first = points.find((point) => point.t >= windowStart) ?? low;
  // A run of the same value that started before the window still covers it.
  const olderExists = points.some((point) => point.t < windowStart);
  return { previousLow: low, since: first.t, fullWindow: olderExists || now - first.t >= days * DAY_MS - DAY_MS / 2 };
}

/** The part of the history a plan shows: Pro everything, free the last few days (at least two points). */
export function visibleHistory(points: readonly ValuePoint[], full: boolean, now: number, days = FREE_HISTORY_DAYS): ValuePoint[] {
  if (full) return [...points];
  const since = now - days * DAY_MS;
  const firstInside = points.findIndex((point) => point.t >= since);
  if (firstInside < 0) return points.slice(-2);
  return points.slice(Math.max(0, Math.min(firstInside, points.length - 2)));
}

// --- Chart geometry ------------------------------------------------------------------------------

export interface Box {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartPoint {
  x: number;
  y: number;
  point: ValuePoint;
}

export interface ChartGeometry {
  /** Step line: a value holds until the next check that saw a different one. */
  line: string;
  /** The line closed down to the bottom of the plot, for a light wash. */
  area: string;
  points: ChartPoint[];
  min: ChartPoint;
  max: ChartPoint;
  last: ChartPoint;
  /** Plot edges. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Places the points in the box: time left to right, value bottom to top. */
export function chartGeometry(points: readonly ValuePoint[], box: Box): ChartGeometry | null {
  if (points.length === 0) return null;
  const x0 = box.left;
  const x1 = box.width - box.right;
  const y0 = box.top;
  const y1 = box.height - box.bottom;
  const first = points[0]!.t;
  const lastTime = points[points.length - 1]!.t;
  const span = lastTime - first;
  let low = Infinity;
  let high = -Infinity;
  for (const point of points) {
    low = Math.min(low, point.v);
    high = Math.max(high, point.v);
  }
  const range = high - low;
  const x = (t: number) => round(span === 0 ? (points.length === 1 ? x1 : (x0 + x1) / 2) : x0 + ((t - first) / span) * (x1 - x0));
  const y = (v: number) => round(range === 0 ? (y0 + y1) / 2 : y1 - ((v - low) / range) * (y1 - y0));
  const placed = points.map((point) => ({ x: x(point.t), y: y(point.v), point }));

  let line = `M${placed[0]!.x} ${placed[0]!.y}`;
  for (let i = 1; i < placed.length; i++) {
    const { x: px, y: py } = placed[i]!;
    if (py !== placed[i - 1]!.y) line += `H${px}V${py}`;
    else line += `H${px}`;
  }
  const lastPoint = placed[placed.length - 1]!;
  const area = `${line}V${y1}H${placed[0]!.x}Z`;
  let min = placed[0]!;
  let max = placed[0]!;
  for (const point of placed) {
    if (point.point.v < min.point.v) min = point;
    if (point.point.v > max.point.v) max = point;
  }
  return { line, area, points: placed, min, max, last: lastPoint, x0, x1, y0, y1 };
}

/** The point nearest to an x position (for the crosshair). */
export function nearestPoint(points: readonly ChartPoint[], x: number): ChartPoint | null {
  let best: ChartPoint | null = null;
  for (const point of points) if (!best || Math.abs(point.x - x) < Math.abs(best.x - x)) best = point;
  return best;
}

// --- Storage ----------------------------------------------------------------------------------------

export function sanitizeHistory(raw: unknown): ValuePoint[] {
  if (!Array.isArray(raw)) return [];
  const points: ValuePoint[] = [];
  let lastTime = -Infinity;
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { t, v, r } = item as Record<string, unknown>;
    if (typeof t !== 'number' || !Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v) || t < lastTime) continue;
    points.push({ t, v, r: typeof r === 'string' && r ? r.slice(0, 40) : String(v) });
    lastTime = t;
  }
  return points.slice(-MAX_POINTS);
}
