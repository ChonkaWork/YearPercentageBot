import { assetName } from './assets';
import { formatNumber, formatPercent, formatRatio } from './format';
import { INDICATOR_KEYS, signalDirection, type Analysis, type IndicatorKey, type Indicators } from './signal';
import type { Interval } from './types';

/**
 * Plain-language explanation of an analysis. The MVP generator is deterministic and local:
 * it only restates the indicator values, never predicts prices or invents news or causes.
 * The interface is async so an LLM-backed implementation can replace it later without
 * touching the UI.
 */

export interface ExplanationInput {
  symbol: string;
  name?: string;
  interval: Interval;
  analysis: Analysis;
  /** Indicators to leave out of the text (e.g. ones the plan doesn't show). The signal still uses them. */
  omit?: readonly IndicatorKey[];
}

export type ReasonKind = 'support' | 'caution' | 'neutral';
export type Lean = 'up' | 'down' | 'flat';

export interface Reason {
  /**
   * support: points the same way as the signal (✓). caution: points the other way, or a
   * missing confirmation (⚠). neutral: adds nothing either way; for a NEUTRAL signal every
   * indicator is listed as neutral with its lean, since nothing "supports" or "contradicts" it.
   */
  kind: ReasonKind;
  /** Which way the indicator itself points (sign of its points). */
  lean: Lean;
  indicator: IndicatorKey;
  text: string;
}

export interface Explanation {
  /** Two to four sentences. */
  sentences: string[];
  /** "Why this signal": one entry per indicator, supporting ones first. */
  reasons: Reason[];
  /** Which generator produced the text (e.g. "local-rules-v1"). */
  generator: string;
}

export interface AIExplanationService {
  readonly id: string;
  explain(input: ExplanationInput, options?: { signal?: AbortSignal }): Promise<Explanation>;
}

export const LOCAL_GENERATOR_ID = 'local-rules-v1';

/** Deterministic, offline generator. */
export class LocalExplanationService implements AIExplanationService {
  readonly id = LOCAL_GENERATOR_ID;

  async explain(input: ExplanationInput): Promise<Explanation> {
    return buildExplanation(input);
  }
}

export function createExplanationService(): AIExplanationService {
  return new LocalExplanationService();
}

export function buildExplanation(input: ExplanationInput): Explanation {
  const { analysis } = input;
  const name = input.name ?? assetName(input.symbol);
  const omit = new Set(input.omit ?? []);
  const sentences = [
    overviewSentence(name, input.interval, analysis),
    trendSentence(analysis.indicators),
    momentumSentence(analysis.indicators),
    // The last sentence is about volume (and momentum for neutral markets).
    omit.has('volume') || omit.has('momentum') ? null : volumeSentence(analysis),
  ].filter((sentence): sentence is string => Boolean(sentence));
  const reasons = buildReasons(analysis).filter((reason) => !omit.has(reason.indicator));
  return { sentences, reasons, generator: LOCAL_GENERATOR_ID };
}

// --- Sentences --------------------------------------------------------------------------

const CHART_NAME: Readonly<Record<Interval, string>> = { '1h': '1-hour chart', '4h': '4-hour chart', '1d': 'daily chart' };

function overviewSentence(name: string, interval: Interval, analysis: Analysis): string {
  const chart = CHART_NAME[interval];
  const points = INDICATOR_KEYS.map((key) => analysis.indicators[key].points);
  const up = points.filter((p) => p > 0).length;
  const down = points.filter((p) => p < 0).length;
  const total = INDICATOR_KEYS.length;
  switch (analysis.signal) {
    case 'STRONG_BULLISH':
      return `${name} shows strong bullish momentum on the ${chart}: ${up} of ${total} indicators point up.`;
    case 'BULLISH':
      return `${name} leans bullish on the ${chart}, with ${up} of ${total} indicators pointing up.`;
    case 'STRONG_BEARISH':
      return `${name} shows strong bearish momentum on the ${chart}: ${down} of ${total} indicators point down.`;
    case 'BEARISH':
      return `${name} leans bearish on the ${chart}, with ${down} of ${total} indicators pointing down.`;
    case 'NEUTRAL':
      if (up === 0 && down === 0) return `${name} shows no clear direction on the ${chart}: every indicator reads flat.`;
      if (up > 0 && down > 0) {
        return `${name} has no clear direction on the ${chart}: ${count(up, 'indicator points', 'indicators point')} up and ${down} down, so they largely cancel out.`;
      }
      return `${name} has no clear direction on the ${chart}: only ${count(up || down, 'indicator points', 'indicators point')} ${up ? 'up' : 'down'}.`;
  }
}

function trendSentence(indicators: Indicators): string {
  const { priceVsEma50, trend } = indicators;
  const distance = distanceText(priceVsEma50.distancePct);
  const price = priceVsEma50.points;
  const averages = trend.points;
  if (price > 0 && averages > 0) {
    return `Price is ${distance} above the EMA50 and the EMA20 is above the EMA50, so the medium-term trend is up.`;
  }
  if (price < 0 && averages < 0) {
    return `Price is ${distance} below the EMA50 and the EMA20 is below the EMA50, so the medium-term trend is down.`;
  }
  if (price > 0 && averages < 0) {
    return `Price is back above the EMA50 (${distance} above), but the EMA20 is still below the EMA50, so the medium-term trend is still down.`;
  }
  if (price < 0 && averages > 0) {
    return `Price has slipped ${distance} below the EMA50 while the EMA20 is still above it, so the uptrend is being tested.`;
  }
  const pricePart = price > 0 ? `Price is ${distance} above the EMA50` : price < 0 ? `Price is ${distance} below the EMA50` : 'Price is at the EMA50';
  const averagesPart =
    averages > 0 ? 'the EMA20 is above the EMA50' : averages < 0 ? 'the EMA20 is below the EMA50' : 'the EMA20 and EMA50 are level';
  return `${pricePart} and ${averagesPart}, so there is no clear trend.`;
}

function momentumSentence(indicators: Indicators): string {
  return `${capitalize(macdPhrase(indicators.macd))}, and ${rsiPhrase(indicators)}.`;
}

function volumeSentence(analysis: Analysis): string {
  const { volume, momentum } = analysis.indicators;
  const direction = signalDirection(analysis.signal);
  const change = `${formatPercent(momentum.changePct, 1)} over the last ${momentum.period} candles`;
  if (volume.ratio === null) {
    return `Price moved ${change}; volume data isn't usable for this market, so the move can't be checked against volume.`;
  }
  const ratio = formatRatio(volume.ratio);
  if (direction === 0) {
    return `Price moved ${change}, and the last closed candle traded ${ratio} its 20-candle average volume.`;
  }
  const read = direction > 0 ? 'bullish' : 'bearish';
  if (volume.points * direction > 0) {
    return `The last closed candle traded ${ratio} its 20-candle average volume in the direction of the move, which confirms the ${read} read.`;
  }
  if (volume.points * direction < 0) {
    return `The last closed candle was a ${volume.candle} candle on ${ratio} average volume, which works against the ${read} read.`;
  }
  if (volume.ratio <= 1) {
    return `Volume on the last closed candle was ${ratio} its 20-candle average, so the move lacks volume confirmation.`;
  }
  return `Volume was above average (${ratio}) on a flat candle, which doesn't confirm either side.`;
}

function macdPhrase(macd: Indicators['macd']): string {
  switch (macd.state) {
    case 'bullish-cross':
      return `MACD crossed above its signal line ${agoText(macd.crossAgo)}`;
    case 'bearish-cross':
      return `MACD crossed below its signal line ${agoText(macd.crossAgo)}`;
    case 'bullish':
      return 'the MACD histogram is positive';
    case 'bearish':
      return 'the MACD histogram is negative';
    case 'neutral':
      return 'MACD is flat';
  }
}

function rsiPhrase(indicators: Indicators): string {
  const { rsi, trend } = indicators;
  const value = formatNumber(rsi.value, 1);
  switch (rsi.zone) {
    case 'oversold':
      return `RSI is ${value}, in oversold territory`;
    case 'weak':
      return `RSI is ${value}, on the soft side`;
    case 'neutral':
      return `RSI is ${value}, mid-range`;
    case 'firm':
      return trend.state === 'up' ? `RSI is ${value}, firm but not overbought` : `RSI is ${value}, elevated for a market without an uptrend`;
    case 'overbought':
      return `RSI is ${value}, above the overbought line of 70`;
  }
}

// --- Reasons ----------------------------------------------------------------------------

export function buildReasons(analysis: Analysis): Reason[] {
  const direction = signalDirection(analysis.signal);
  const reasons = INDICATOR_KEYS.map((key): Reason => {
    const points = analysis.indicators[key].points;
    const lean: Lean = points > 0 ? 'up' : points < 0 ? 'down' : 'flat';
    const text = reasonText(key, analysis.indicators);
    if (direction === 0) return { kind: 'neutral', lean, indicator: key, text };
    if (points * direction > 0) return { kind: 'support', lean, indicator: key, text };
    if (points * direction < 0) return { kind: 'caution', lean, indicator: key, text };
    // A directional signal without volume behind it is worth a warning; other flat readings just add nothing.
    const unconfirmed = key === 'volume' && (analysis.indicators.volume.ratio === null || analysis.indicators.volume.ratio <= 1);
    return { kind: unconfirmed ? 'caution' : 'neutral', lean, indicator: key, text };
  });
  const order = (reason: Reason) =>
    direction === 0 ? { up: 0, down: 1, flat: 2 }[reason.lean] : { support: 0, caution: 1, neutral: 2 }[reason.kind];
  return reasons.map((reason, index) => ({ reason, index })).sort((a, b) => order(a.reason) - order(b.reason) || a.index - b.index).map(({ reason }) => reason);
}

function reasonText(key: IndicatorKey, indicators: Indicators): string {
  switch (key) {
    case 'rsi': {
      const { value, zone } = indicators.rsi;
      const v = formatNumber(value, 1);
      if (zone === 'oversold') return `RSI ${v} is oversold (below 30)`;
      if (zone === 'weak') return `RSI ${v} is on the soft side (30–45)`;
      if (zone === 'neutral') return `RSI ${v} is mid-range (45–55)`;
      if (zone === 'firm') return indicators.trend.state === 'up' ? `RSI ${v} is firm, normal in an uptrend` : `RSI ${v} is elevated without an uptrend`;
      return `RSI ${v} is overbought (above 70)`;
    }
    case 'macd':
      return capitalize(macdPhrase(indicators.macd).replace(/^the /, ''));
    case 'priceVsEma50': {
      const { points, distancePct } = indicators.priceVsEma50;
      if (points > 0) return `Price is ${distanceText(distancePct)} above the EMA50`;
      if (points < 0) return `Price is ${distanceText(distancePct)} below the EMA50`;
      return 'Price is at the EMA50';
    }
    case 'trend': {
      const { state } = indicators.trend;
      if (state === 'up') return 'EMA20 is above the EMA50 (uptrend)';
      if (state === 'down') return 'EMA20 is below the EMA50 (downtrend)';
      return 'EMA20 and EMA50 are level';
    }
    case 'momentum': {
      const { changePct, period, state } = indicators.momentum;
      const pct = formatPercent(changePct, 1);
      if (state === 'up') return `Up ${pct.replace('+', '')} over the last ${period} candles`;
      if (state === 'down') return `Down ${pct.replace('−', '')} over the last ${period} candles`;
      return `Flat over the last ${period} candles (${pct})`;
    }
    case 'volume': {
      const { ratio, points, candle } = indicators.volume;
      if (ratio === null) return 'No usable volume data';
      const text = formatRatio(ratio);
      if (points > 0) return `Volume ${text} average on an up candle`;
      if (points < 0) return `Volume ${text} average on a down candle`;
      if (ratio <= 1) return `Volume ${text} average: no confirmation`;
      return `Volume ${text} average on a ${candle} candle`;
    }
  }
}

// --- Helpers ----------------------------------------------------------------------------

function distanceText(distancePct: number): string {
  const abs = Math.abs(distancePct);
  return abs < 0.1 ? 'just' : `${formatNumber(abs, 1)}%`;
}

function agoText(crossAgo: number | null): string {
  if (crossAgo === null || crossAgo <= 0) return 'on the latest candle';
  return `${count(crossAgo, 'candle', 'candles')} ago`;
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
