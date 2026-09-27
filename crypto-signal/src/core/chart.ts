import type { Series } from './indicators';

/** Pure geometry for the mini chart: SVG path strings from price and EMA series. */

export interface ChartInput {
  close: readonly number[];
  ema20: Series;
  ema50: Series;
}

export interface ChartBox {
  width: number;
  height: number;
  padTop: number;
  padRight: number;
  padBottom: number;
  padLeft: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ChartGeometry {
  price: string;
  /** Closed area under the price line, for a faint wash. */
  area: string;
  ema20: string;
  ema50: string;
  /** Price points by candle index (for the hover crosshair). */
  points: Point[];
  last: Point;
  /** Highest and lowest close in view, with their positions. */
  high: { value: number; point: Point };
  low: { value: number; point: Point };
  domain: { min: number; max: number };
}

/** Null when there are fewer than two usable prices. */
export function chartGeometry(input: ChartInput, box: ChartBox): ChartGeometry | null {
  const closes = input.close;
  if (closes.length < 2 || !closes.every((value) => Number.isFinite(value))) return null;

  const values = [...closes, ...finite(input.ema20), ...finite(input.ema50)];
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < Math.abs(max) * 1e-9 || max === min) {
    const pad = Math.abs(max) * 0.01 || 1;
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.06;
    min -= pad;
    max += pad;
  }

  const innerWidth = box.width - box.padLeft - box.padRight;
  const innerHeight = box.height - box.padTop - box.padBottom;
  const step = innerWidth / (closes.length - 1);
  const x = (i: number) => box.padLeft + i * step;
  const y = (value: number) => box.padTop + ((max - value) / (max - min)) * innerHeight;

  const points = closes.map((value, i) => ({ x: round(x(i)), y: round(y(value)) }));
  const price = linePath(closes, x, y);
  const baseline = round(box.height - box.padBottom);
  const area = `${price} L${points[points.length - 1]!.x} ${baseline} L${points[0]!.x} ${baseline} Z`;

  let highIndex = 0;
  let lowIndex = 0;
  closes.forEach((value, i) => {
    if (value > closes[highIndex]!) highIndex = i;
    if (value < closes[lowIndex]!) lowIndex = i;
  });

  return {
    price,
    area,
    ema20: linePath(input.ema20, x, y),
    ema50: linePath(input.ema50, x, y),
    points,
    last: points[points.length - 1]!,
    high: { value: closes[highIndex]!, point: points[highIndex]! },
    low: { value: closes[lowIndex]!, point: points[lowIndex]! },
    domain: { min, max },
  };
}

/** Nearest candle index for a horizontal position. */
export function nearestIndex(xPosition: number, points: readonly Point[]): number {
  if (!points.length) return -1;
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i]!.x - xPosition) < Math.abs(points[best]!.x - xPosition)) best = i;
  }
  return best;
}

/** "M x y L x y …", starting a new segment after gaps (nulls). Empty string when nothing is drawable. */
function linePath(values: readonly (number | null)[], x: (i: number) => number, y: (value: number) => number): string {
  const parts: string[] = [];
  let drawing = false;
  values.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) {
      drawing = false;
      return;
    }
    parts.push(`${drawing ? 'L' : 'M'}${round(x(i))} ${round(y(value))}`);
    drawing = true;
  });
  return parts.join(' ');
}

function finite(series: Series): number[] {
  return series.filter((value): value is number => value !== null && Number.isFinite(value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
