import { ema, lastValue, macd, rateOfChange, rsi, type Series } from './indicators';
import { isFiniteNumber, type Candle } from './types';

/**
 * The signal engine: indicators from OHLCV candles → points → a label and a strength.
 * Pure and UI-independent. See README "Signal engine" for the scoring table.
 */

export const SIGNAL_LABELS = ['STRONG_BULLISH', 'BULLISH', 'NEUTRAL', 'BEARISH', 'STRONG_BEARISH'] as const;
export type SignalLabel = (typeof SIGNAL_LABELS)[number];

export function isSignalLabel(value: unknown): value is SignalLabel {
  return typeof value === 'string' && (SIGNAL_LABELS as readonly string[]).includes(value);
}

export const SIGNAL_TEXT: Readonly<Record<SignalLabel, string>> = Object.freeze({
  STRONG_BULLISH: 'Strong bullish',
  BULLISH: 'Bullish',
  NEUTRAL: 'Neutral',
  BEARISH: 'Bearish',
  STRONG_BEARISH: 'Strong bearish',
});

/** +1 for bullish labels, −1 for bearish, 0 for neutral. */
export function signalDirection(signal: SignalLabel): 1 | 0 | -1 {
  if (signal === 'STRONG_BULLISH' || signal === 'BULLISH') return 1;
  if (signal === 'STRONG_BEARISH' || signal === 'BEARISH') return -1;
  return 0;
}

export const ENGINE_CONFIG = Object.freeze({
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  /** A MACD crossover counts as "recent" when it happened on one of the last N candles. */
  macdCrossLookback: 3,
  /** |histogram| below this fraction of the price is treated as flat (0.001%). */
  macdNeutralFraction: 1e-5,
  emaFast: 20,
  emaSlow: 50,
  /** Momentum = rate of change of the close over this many candles. */
  momentumPeriod: 10,
  /** |rate of change| below this percentage counts as flat. */
  momentumFlatPct: 0.1,
  /** Volume of the last closed candle is compared with the mean of the N closed candles before it. */
  volumePeriod: 20,
  /** EMA50 needs 50 candles; the rest gives the crossover lookback and volume window room. */
  minCandles: 60,
  /** Candles kept for the mini chart. */
  chartPoints: 60,
});

/** RSI ±2, MACD ±2, price vs EMA50 ±1, EMA20 vs EMA50 ±1, momentum ±1, volume ±1. */
export const MAX_SCORE = 8;

/** Inclusive score thresholds. Everything between −1 and +1 is NEUTRAL. */
export const THRESHOLDS = Object.freeze({ strongBullish: 5, bullish: 2, bearish: -2, strongBearish: -5 });

export type RsiZone = 'oversold' | 'weak' | 'neutral' | 'firm' | 'overbought';
export type MacdState = 'bullish-cross' | 'bullish' | 'neutral' | 'bearish' | 'bearish-cross';
export type Direction = 'up' | 'down' | 'flat';

export interface Indicators {
  rsi: { value: number; zone: RsiZone; points: number };
  macd: { line: number; signal: number; histogram: number; state: MacdState; crossAgo: number | null; points: number };
  priceVsEma50: { price: number; ema50: number; distancePct: number; points: number };
  trend: { ema20: number; ema50: number; state: Direction; points: number };
  momentum: { changePct: number; period: number; state: Direction; points: number };
  volume: {
    /** Volume of the last closed candle divided by the average. Null when there is no usable volume. */
    ratio: number | null;
    /** Direction of the candle that carried the volume. */
    candle: Direction;
    points: number;
  };
}

export type IndicatorKey = keyof Indicators;
export const INDICATOR_KEYS: readonly IndicatorKey[] = ['rsi', 'macd', 'priceVsEma50', 'trend', 'momentum', 'volume'];

export interface ChartSeries {
  time: number[];
  close: number[];
  ema20: Series;
  ema50: Series;
}

export interface Analysis {
  score: number;
  maxScore: number;
  signal: SignalLabel;
  /** 0–100: |score| relative to the maximum possible score. Not a probability. */
  strength: number;
  /** Close of the latest candle. */
  price: number;
  /** Open time of the latest candle. */
  candleTime: number;
  candleCount: number;
  indicators: Indicators;
  chart: ChartSeries;
}

export type AnalysisOutcome =
  | { ok: true; analysis: Analysis }
  | { ok: false; reason: 'insufficient-data'; needed: number; got: number }
  | { ok: false; reason: 'invalid-data'; detail: string };

export interface AnalyzeOptions {
  /** Current time, used to tell the in-progress candle from closed ones. */
  now: number;
}

export function analyze(candles: readonly Candle[], options: AnalyzeOptions): AnalysisOutcome {
  const problem = validateCandles(candles);
  if (problem) return { ok: false, reason: 'invalid-data', detail: problem };
  const cfg = ENGINE_CONFIG;
  if (candles.length < cfg.minCandles) {
    return { ok: false, reason: 'insufficient-data', needed: cfg.minCandles, got: candles.length };
  }

  const closes = candles.map((candle) => candle.close);
  const last = candles.length - 1;
  const price = closes[last]!;

  const ema20Series = ema(closes, cfg.emaFast);
  const ema50Series = ema(closes, cfg.emaSlow);
  const ema20 = lastValue(ema20Series)!;
  const ema50 = lastValue(ema50Series)!;

  const trendState = compare(ema20, ema50);
  const trend = { ema20, ema50, state: trendState, points: directionPoints(trendState) };

  const priceState = compare(price, ema50);
  const priceVsEma50 = {
    price,
    ema50,
    distancePct: ((price - ema50) / ema50) * 100,
    points: directionPoints(priceState),
  };

  const rsiValue = lastValue(rsi(closes, cfg.rsiPeriod))!;
  const rsiResult = { value: rsiValue, zone: rsiZone(rsiValue), points: scoreRsi(rsiValue, trendState === 'up') };

  const macdSeries = macd(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const macdRead = classifyMacd(macdSeries.histogram, price, cfg.macdCrossLookback);
  const macdResult = {
    line: lastValue(macdSeries.macd)!,
    signal: lastValue(macdSeries.signal)!,
    histogram: lastValue(macdSeries.histogram)!,
    state: macdRead.state,
    crossAgo: macdRead.crossAgo,
    points: scoreMacd(macdRead.state),
  };

  const changePct = rateOfChange(closes, cfg.momentumPeriod)!;
  const momentumState: Direction =
    changePct > cfg.momentumFlatPct ? 'up' : changePct < -cfg.momentumFlatPct ? 'down' : 'flat';
  const momentum = { changePct, period: cfg.momentumPeriod, state: momentumState, points: directionPoints(momentumState) };

  const volume = volumeConfirmation(candles, options.now);

  const indicators: Indicators = { rsi: rsiResult, macd: macdResult, priceVsEma50, trend, momentum, volume };
  const score = INDICATOR_KEYS.reduce((sum, key) => sum + indicators[key].points, 0);

  const from = Math.max(0, candles.length - cfg.chartPoints);
  const chart: ChartSeries = {
    time: candles.slice(from).map((candle) => candle.openTime),
    close: closes.slice(from),
    ema20: ema20Series.slice(from),
    ema50: ema50Series.slice(from),
  };

  return {
    ok: true,
    analysis: {
      score,
      maxScore: MAX_SCORE,
      signal: classify(score),
      strength: signalStrength(score),
      price,
      candleTime: candles[last]!.openTime,
      candleCount: candles.length,
      indicators,
      chart,
    },
  };
}

// --- Scoring rules ----------------------------------------------------------------------

export function classify(score: number): SignalLabel {
  if (score >= THRESHOLDS.strongBullish) return 'STRONG_BULLISH';
  if (score >= THRESHOLDS.bullish) return 'BULLISH';
  if (score <= THRESHOLDS.strongBearish) return 'STRONG_BEARISH';
  if (score <= THRESHOLDS.bearish) return 'BEARISH';
  return 'NEUTRAL';
}

export function signalStrength(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.round((Math.min(Math.abs(score), MAX_SCORE) / MAX_SCORE) * 100);
}

export function rsiZone(value: number): RsiZone {
  if (value < 30) return 'oversold';
  if (value < 45) return 'weak';
  if (value <= 55) return 'neutral';
  if (value <= 70) return 'firm';
  return 'overbought';
}

/**
 * RSI < 30 → +2, 30–45 → +1, 45–55 → 0, above 70 → −2.
 * 55–70: 0 in an uptrend (EMA20 above EMA50), where a firm RSI is normal; −1 otherwise,
 * where the same reading is a rally running into a weak or sideways trend.
 */
export function scoreRsi(value: number, uptrend: boolean): number {
  switch (rsiZone(value)) {
    case 'oversold':
      return 2;
    case 'weak':
      return 1;
    case 'neutral':
      return 0;
    case 'firm':
      return uptrend ? 0 : -1;
    case 'overbought':
      return -2;
  }
}

export function scoreMacd(state: MacdState): number {
  switch (state) {
    case 'bullish-cross':
      return 2;
    case 'bullish':
      return 1;
    case 'neutral':
      return 0;
    case 'bearish':
      return -1;
    case 'bearish-cross':
      return -2;
  }
}

/**
 * Reads the MACD histogram. A crossover is the histogram changing sign into its current sign
 * on one of the last `lookback` candles (crossAgo 0 = the latest candle). If the sign flipped
 * back since, it isn't a crossover any more, just the current histogram sign.
 */
export function classifyMacd(
  histogram: Series,
  price: number,
  lookback: number = ENGINE_CONFIG.macdCrossLookback,
): { state: MacdState; crossAgo: number | null } {
  const epsilon = Math.abs(price) * ENGINE_CONFIG.macdNeutralFraction;
  const sign = (value: number) => (value > epsilon ? 1 : value < -epsilon ? -1 : 0);
  const last = histogram.length - 1;
  const current = histogram[last];
  if (current === null || current === undefined) return { state: 'neutral', crossAgo: null };
  const direction = sign(current);
  if (direction === 0) return { state: 'neutral', crossAgo: null };

  for (let i = last; i > last - lookback && i >= 1; i--) {
    const previous = histogram[i - 1];
    if (previous === null || previous === undefined) break;
    if (sign(previous) !== direction) {
      return { state: direction > 0 ? 'bullish-cross' : 'bearish-cross', crossAgo: last - i };
    }
  }
  return { state: direction > 0 ? 'bullish' : 'bearish', crossAgo: null };
}

/**
 * Volume confirmation. The in-progress candle's volume is partial, so the last *closed* candle
 * is compared with the average of the closed candles before it. Above-average volume confirms
 * the direction of that candle: +1 on an up candle, −1 on a down candle (so a heavy sell-off
 * never adds a bullish point), 0 otherwise.
 */
export function volumeConfirmation(candles: readonly Candle[], now: number): Indicators['volume'] {
  const period = ENGINE_CONFIG.volumePeriod;
  const last = candles.length - 1;
  const closedIndex = candles[last] && candles[last].closeTime <= now ? last : last - 1;
  const closed = candles[closedIndex];
  if (!closed || closedIndex < period) return { ratio: null, candle: 'flat', points: 0 };

  let sum = 0;
  for (let i = closedIndex - period; i < closedIndex; i++) sum += candles[i]!.volume;
  const average = sum / period;
  const candle = compare(closed.close, closed.open);
  if (!(average > 0)) return { ratio: null, candle, points: 0 };

  const ratio = closed.volume / average;
  const above = ratio > 1;
  const points = above ? directionPoints(candle) : 0;
  return { ratio, candle, points };
}

// --- Helpers ----------------------------------------------------------------------------

/** 'up' when a > b, 'down' when a < b, 'flat' when they're equal within float noise. */
function compare(a: number, b: number): Direction {
  const scale = Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
  const diff = (a - b) / scale;
  if (Math.abs(diff) < 1e-9) return 'flat';
  return diff > 0 ? 'up' : 'down';
}

function directionPoints(direction: Direction): number {
  return direction === 'up' ? 1 : direction === 'down' ? -1 : 0;
}

/** Returns a description of the first problem, or null when every candle is usable. */
export function validateCandles(candles: readonly Candle[]): string | null {
  if (!Array.isArray(candles)) return 'candles is not an array';
  let previousOpen = -Infinity;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle || typeof candle !== 'object') return `candle ${i} is missing`;
    const { openTime, closeTime, open, high, low, close, volume } = candle;
    const numbers = [openTime, closeTime, open, high, low, close, volume];
    if (!numbers.every(isFiniteNumber)) return `candle ${i} has a non-finite value`;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return `candle ${i} has a non-positive price`;
    if (volume < 0) return `candle ${i} has negative volume`;
    if (low > Math.min(open, close) || high < Math.max(open, close)) return `candle ${i} has an inconsistent range`;
    if (closeTime <= openTime) return `candle ${i} closes before it opens`;
    if (openTime <= previousOpen) return `candle ${i} is out of order`;
    previousOpen = openTime;
  }
  return null;
}
