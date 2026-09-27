import { formatPp, formatProbability } from './format';
import { TREND_DEADBAND_PP } from './momentum';
import { toPp } from './numbers';
import { cleanSeries, significantMoves } from './series';
import { DAY_MS, HOUR_MS, type HistoryRange, type PricePoint } from './types';

/**
 * Pure geometry for the price chart (SVG coordinates). No chart library: a line, an area,
 * a few grid lines, labelled significant moves and the current value.
 */

export interface ChartBox {
  width: number;
  height: number;
  /** Space for the y labels on the right and the x labels at the bottom. */
  padding: { top: number; right: number; bottom: number; left: number };
}

export interface ChartGeometry {
  line: string;
  area: string;
  points: { x: number; y: number; t: number; p: number }[];
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
  markers: { x: number; y: number; change: number; label: string; direction: 'up' | 'down' }[];
  last: { x: number; y: number; label: string };
  direction: 'up' | 'down' | 'flat';
  domain: { min: number; max: number };
  summary: string;
}

/** Significant move settings per range: window and minimum size. */
export const MOVE_SETTINGS: Record<HistoryRange, { windowMs: number; thresholdPp: number }> = {
  '24h': { windowMs: HOUR_MS, thresholdPp: 3 },
  '7d': { windowMs: 6 * HOUR_MS, thresholdPp: 4 },
  '30d': { windowMs: DAY_MS, thresholdPp: 6 },
};

const TICK_STEPS_PP = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50];

export function chartGeometry(history: readonly PricePoint[], range: HistoryRange, box: ChartBox): ChartGeometry | null {
  const series = cleanSeries(history);
  if (series.length < 2) return null;
  const first = series[0]!;
  const last = series[series.length - 1]!;

  // Domain: data range with 12% headroom, at least 4 pp tall, inside [0, 1].
  let min = Math.min(...series.map((point) => point.p));
  let max = Math.max(...series.map((point) => point.p));
  const span = Math.max(max - min, 0.04);
  const middle = (min + max) / 2;
  min = Math.max(0, middle - (span / 2) * 1.24);
  max = Math.min(1, middle + (span / 2) * 1.24);

  const plotLeft = box.padding.left;
  const plotRight = box.width - box.padding.right;
  const plotTop = box.padding.top;
  const plotBottom = box.height - box.padding.bottom;
  const tSpan = Math.max(1, last.t - first.t);
  const x = (t: number) => plotLeft + ((t - first.t) / tSpan) * (plotRight - plotLeft);
  const y = (p: number) => plotBottom - ((p - min) / (max - min || 1)) * (plotBottom - plotTop);
  const round = (value: number) => Math.round(value * 10) / 10;

  const points = series.map((point) => ({ x: round(x(point.t)), y: round(y(point.p)), t: point.t, p: point.p }));
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ');
  const area = `${line} L${points[points.length - 1]!.x} ${plotBottom} L${points[0]!.x} ${plotBottom} Z`;

  // Y ticks: a "nice" step giving 3–5 lines.
  const spanPp = (max - min) * 100;
  const step = TICK_STEPS_PP.find((candidate) => spanPp / candidate <= 4) ?? 50;
  const yTicks: ChartGeometry['yTicks'] = [];
  for (let value = Math.ceil((min * 100) / step) * step; value <= max * 100 + 1e-9; value += step) {
    yTicks.push({ y: round(y(value / 100)), label: `${Number(value.toFixed(1))}%` });
  }

  const xTicks = [0, 1 / 3, 2 / 3, 1].map((fraction) => {
    const t = first.t + fraction * tSpan;
    return { x: round(x(t)), label: timeLabel(t, range) };
  });

  const settings = MOVE_SETTINGS[range];
  const markers = significantMoves(series, settings.windowMs, settings.thresholdPp, 3).map((move) => ({
    x: round(x(move.t)),
    y: round(y(move.p)),
    change: move.change,
    label: formatPp(move.change, { unit: false }),
    direction: move.change >= 0 ? ('up' as const) : ('down' as const),
  }));

  // Same 0.5 pp deadband as the momentum trend: a drift of a few tenths is drawn neutral.
  const changePp = toPp(last.p - first.p);
  const direction = Math.abs(changePp) < TREND_DEADBAND_PP ? 'flat' : changePp > 0 ? 'up' : 'down';

  return {
    line,
    area,
    points,
    yTicks,
    xTicks,
    markers,
    last: { x: round(x(last.t)), y: round(y(last.p)), label: formatProbability(last.p) },
    direction,
    domain: { min, max },
    summary: `Price over ${RANGE_WORDS[range]}: from ${formatProbability(first.p)} to ${formatProbability(last.p)} (${formatPp(last.p - first.p)}), low ${formatProbability(
      Math.min(...series.map((point) => point.p)),
    )}, high ${formatProbability(Math.max(...series.map((point) => point.p)))}.`,
  };
}

const RANGE_WORDS: Record<HistoryRange, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

export function timeLabel(t: number, range: HistoryRange): string {
  const date = new Date(t);
  if (range === '24h') return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Index of the point nearest to x (for the hover crosshair). */
export function nearestPoint(points: readonly { x: number }[], x: number): number {
  let best = 0;
  for (let index = 1; index < points.length; index++) {
    if (Math.abs(points[index]!.x - x) < Math.abs(points[best]!.x - x)) best = index;
  }
  return best;
}
