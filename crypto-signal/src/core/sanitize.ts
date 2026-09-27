import type { Explanation, Reason } from './explain';
import type { Series } from './indicators';
import {
  INDICATOR_KEYS,
  isSignalLabel,
  MAX_SCORE,
  type Analysis,
  type ChartSeries,
  type Direction,
  type Indicators,
  type MacdState,
  type RsiZone,
} from './signal';
import { isFiniteNumber, type Candle } from './types';

/**
 * Validators for data read back from chrome.storage. Storage can hold anything (older
 * versions, manual edits, partial writes), so every reader rebuilds typed objects from
 * scratch and returns null for anything that doesn't check out.
 */

type Loose = Record<string, unknown>;

export function asObject(value: unknown): Loose | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Loose) : null;
}

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | null {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : null;
}

const DIRECTIONS: readonly Direction[] = ['up', 'down', 'flat'];
const RSI_ZONES: readonly RsiZone[] = ['oversold', 'weak', 'neutral', 'firm', 'overbought'];
const MACD_STATES: readonly MacdState[] = ['bullish-cross', 'bullish', 'neutral', 'bearish', 'bearish-cross'];

export function sanitizeCandles(raw: unknown): Candle[] | null {
  if (!Array.isArray(raw)) return null;
  const candles: Candle[] = [];
  for (const item of raw) {
    const c = asObject(item);
    if (!c) return null;
    const candle = {
      openTime: num(c.openTime),
      closeTime: num(c.closeTime),
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: num(c.volume),
    };
    if (Object.values(candle).some((value) => value === null)) return null;
    candles.push(candle as Candle);
  }
  return candles;
}

function sanitizeSeries(raw: unknown, length: number): Series | null {
  if (!Array.isArray(raw) || raw.length !== length) return null;
  const out: Series = [];
  for (const value of raw) {
    if (value === null) out.push(null);
    else if (isFiniteNumber(value)) out.push(value);
    else return null;
  }
  return out;
}

function sanitizeChart(raw: unknown): ChartSeries | null {
  const c = asObject(raw);
  if (!c || !Array.isArray(c.close) || !Array.isArray(c.time)) return null;
  const length = c.close.length;
  if (!c.close.every(isFiniteNumber) || c.time.length !== length || !c.time.every(isFiniteNumber)) return null;
  const ema20 = sanitizeSeries(c.ema20, length);
  const ema50 = sanitizeSeries(c.ema50, length);
  if (!ema20 || !ema50) return null;
  return { time: [...c.time] as number[], close: [...c.close] as number[], ema20, ema50 };
}

function points(value: unknown, max: number): number | null {
  return isFiniteNumber(value) && Number.isInteger(value) && Math.abs(value) <= max ? value : null;
}

function sanitizeIndicators(raw: unknown): Indicators | null {
  const i = asObject(raw);
  if (!i) return null;
  const rsi = asObject(i.rsi);
  const macd = asObject(i.macd);
  const price = asObject(i.priceVsEma50);
  const trend = asObject(i.trend);
  const momentum = asObject(i.momentum);
  const volume = asObject(i.volume);
  if (!rsi || !macd || !price || !trend || !momentum || !volume) return null;

  const result = {
    rsi: { value: num(rsi.value), zone: oneOf(rsi.zone, RSI_ZONES), points: points(rsi.points, 2) },
    macd: {
      line: num(macd.line),
      signal: num(macd.signal),
      histogram: num(macd.histogram),
      state: oneOf(macd.state, MACD_STATES),
      crossAgo: macd.crossAgo === null ? null : num(macd.crossAgo),
      points: points(macd.points, 2),
    },
    priceVsEma50: {
      price: num(price.price),
      ema50: num(price.ema50),
      distancePct: num(price.distancePct),
      points: points(price.points, 1),
    },
    trend: { ema20: num(trend.ema20), ema50: num(trend.ema50), state: oneOf(trend.state, DIRECTIONS), points: points(trend.points, 1) },
    momentum: {
      changePct: num(momentum.changePct),
      period: num(momentum.period),
      state: oneOf(momentum.state, DIRECTIONS),
      points: points(momentum.points, 1),
    },
    volume: {
      ratio: volume.ratio === null ? null : num(volume.ratio),
      candle: oneOf(volume.candle, DIRECTIONS),
      points: points(volume.points, 1),
    },
  };
  // crossAgo and ratio may legitimately be null; everything else must be present.
  const required = [
    result.rsi.value, result.rsi.zone, result.rsi.points,
    result.macd.line, result.macd.signal, result.macd.histogram, result.macd.state, result.macd.points,
    result.priceVsEma50.price, result.priceVsEma50.ema50, result.priceVsEma50.distancePct, result.priceVsEma50.points,
    result.trend.ema20, result.trend.ema50, result.trend.state, result.trend.points,
    result.momentum.changePct, result.momentum.period, result.momentum.state, result.momentum.points,
    result.volume.candle, result.volume.points,
  ];
  if (required.some((value) => value === null)) return null;
  if (macd.crossAgo !== null && result.macd.crossAgo === null) return null;
  if (volume.ratio !== null && result.volume.ratio === null) return null;
  return result as Indicators;
}

export function sanitizeAnalysis(raw: unknown): Analysis | null {
  const a = asObject(raw);
  if (!a) return null;
  const indicators = sanitizeIndicators(a.indicators);
  const chart = sanitizeChart(a.chart);
  const score = points(a.score, MAX_SCORE);
  const strength = num(a.strength);
  const price = num(a.price);
  const candleTime = num(a.candleTime);
  const candleCount = num(a.candleCount);
  if (!indicators || !chart || score === null || strength === null || price === null || candleTime === null || candleCount === null) {
    return null;
  }
  if (!isSignalLabel(a.signal) || strength < 0 || strength > 100 || price <= 0) return null;
  // The score must match the indicators it was computed from.
  const total = INDICATOR_KEYS.reduce((sum, key) => sum + indicators[key].points, 0);
  if (total !== score) return null;
  return { score, maxScore: MAX_SCORE, signal: a.signal, strength, price, candleTime, candleCount, indicators, chart };
}

export function sanitizeExplanation(raw: unknown): Explanation | null {
  const e = asObject(raw);
  if (!e || !Array.isArray(e.sentences) || !Array.isArray(e.reasons) || typeof e.generator !== 'string') return null;
  const sentences = e.sentences.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, 6);
  const reasons: Reason[] = [];
  for (const item of e.reasons) {
    const r = asObject(item);
    const kind = oneOf(r?.kind, ['support', 'caution', 'neutral'] as const);
    const lean = oneOf(r?.lean, ['up', 'down', 'flat'] as const);
    const indicator = oneOf(r?.indicator, INDICATOR_KEYS);
    if (!r || !kind || !lean || !indicator || typeof r.text !== 'string') continue;
    reasons.push({ kind, lean, indicator, text: r.text });
  }
  if (!sentences.length) return null;
  return { sentences, reasons, generator: e.generator };
}
