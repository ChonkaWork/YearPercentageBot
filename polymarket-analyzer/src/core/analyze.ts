import { formatPp, formatPpMagnitude, formatRatio, formatUsd } from './format';
import {
  classifyLiquidity,
  measureVolatility,
  volumeActivity,
  type LiquidityLevel,
  type Volatility,
  type VolumeActivity,
} from './metrics';
import { computeMomentum, type Momentum } from './momentum';
import { isFiniteNumber, toPp } from './numbers';
import { checkOutcomeSum, type OutcomeSumCheck } from './probability';
import { changeOverWindow, cleanSeries, largestHourlyMove } from './series';
import { DAY_MS, type Market, type PricePoint } from './types';
import { detectUnusualActivity, type UnusualSignal } from './unusual';

export type ChangeSource = 'market' | 'history';

export interface Factor {
  /** 'support' renders as ✓, 'caution' as ⚠. */
  tone: 'support' | 'caution';
  text: string;
}

export interface Analysis {
  probability: number | null;
  change24h: number | null;
  change24hSource: ChangeSource | null;
  change7d: number | null;
  change7dSource: ChangeSource | null;
  volume: VolumeActivity;
  liquidity: { level: LiquidityLevel; usd: number | null };
  volatility: Volatility;
  momentum: Momentum;
  unusual: UnusualSignal[];
  /** "Why is it moving?" — observations from the data, no causes. */
  factors: Factor[];
  /** Data-quality notes shown with the analysis. */
  warnings: string[];
  outcomeSum: OutcomeSumCheck;
  hasHistory: boolean;
  analyzedAt: number;
}

export interface AnalysisInput {
  market: Market;
  /** Price history of the market's first outcome, ideally the last 7 days. */
  history: readonly PricePoint[] | null;
  now: number;
}

/**
 * The analysis engine: pure, synchronous and independent of Polymarket's response format.
 * Changes reported by the market data are preferred; when missing they are derived from the
 * price history. Nothing is invented when both are missing.
 */
export function analyzeMarket({ market, history, now }: AnalysisInput): Analysis {
  const series = history ? cleanSeries(history) : [];
  const hasHistory = series.length >= 2;
  const warnings: string[] = [];

  const change24h = pickChange(market.change24h, hasHistory ? changeOverWindow(series, DAY_MS) : null);
  const change7d = pickChange(market.change7d, hasHistory ? changeOverWindow(series, 7 * DAY_MS) : null);

  const volume = volumeActivity({
    volume24h: market.volume24h,
    volume7d: market.volume7d,
    marketAgeMs: isFiniteNumber(market.startDate) ? now - market.startDate : null,
  });
  const liquidity = { level: classifyLiquidity(market.liquidity), usd: market.liquidity };
  const volatility = measureVolatility(hasHistory ? series : null);
  const momentum = computeMomentum({
    change24h: change24h.value,
    change7d: change7d.value,
    volume: volume.level,
    liquidity: liquidity.level,
    volatility: volatility.level,
  });
  const unusual = detectUnusualActivity({
    change24h: change24h.value,
    change7d: change7d.value,
    volume,
    liquidity,
    largestHourlyMove: hasHistory ? largestHourlyMove(series, DAY_MS) : null,
  });

  const outcomeSum = checkOutcomeSum(
    market.outcomes.map((outcome) => outcome.probability),
    // Two outcomes of one market are complementary (Yes/No, Team A/Team B).
    market.outcomes.length === 2,
  );
  if (outcomeSum.status === 'inconsistent') {
    warnings.push(`Outcome prices add up to ${Math.round((outcomeSum.sum ?? 0) * 100)}%, which is unusual. Treat the numbers with care.`);
  }
  if (!isFiniteNumber(market.probability)) warnings.push('The current price is missing from the market data.');
  if (!hasHistory) warnings.push('Price history is unavailable, so the chart and volatility are missing.');
  if (change24h.value === null) warnings.push('Not enough data to measure the 24-hour change.');

  return {
    probability: market.probability,
    change24h: change24h.value,
    change24hSource: change24h.source,
    change7d: change7d.value,
    change7dSource: change7d.source,
    volume,
    liquidity,
    volatility,
    momentum,
    unusual,
    factors: explainFactors({ change24h: change24h.value, change7d: change7d.value, volume, liquidity, volatility, hasHistory }),
    warnings,
    outcomeSum,
    hasHistory,
    analyzedAt: now,
  };
}

function pickChange(fromMarket: number | null, fromHistory: number | null): { value: number | null; source: ChangeSource | null } {
  if (isFiniteNumber(fromMarket)) return { value: fromMarket, source: 'market' };
  if (isFiniteNumber(fromHistory)) return { value: fromHistory, source: 'history' };
  return { value: null, source: null };
}

function explainFactors(input: {
  change24h: number | null;
  change7d: number | null;
  volume: VolumeActivity;
  liquidity: { level: LiquidityLevel; usd: number | null };
  volatility: Volatility;
  hasHistory: boolean;
}): Factor[] {
  const factors: Factor[] = [];
  const { change24h, change7d, volume, liquidity, volatility } = input;

  if (isFiniteNumber(change24h)) {
    const pp = toPp(change24h);
    if (Math.abs(pp) < 0.5) factors.push({ tone: 'support', text: `Little change in the last 24 hours (${formatPp(change24h)}).` });
    else factors.push({ tone: 'support', text: `${pp > 0 ? 'Up' : 'Down'} ${formatPpMagnitude(change24h)} in the last 24 hours.` });
  }

  if (isFiniteNumber(change24h) && isFiniteNumber(change7d)) {
    const day = Math.sign(Number(toPp(change24h).toFixed(1)));
    const week = toPp(change7d);
    if (Math.abs(week) >= 0.5 && day !== 0) {
      if (Math.sign(week) === day) factors.push({ tone: 'support', text: `The 7-day trend points the same way (${formatPp(change7d)}).` });
      else factors.push({ tone: 'caution', text: `The 24h move runs against the 7-day trend (${formatPp(change7d)}).` });
    } else if (Math.abs(week) >= 0.5) {
      factors.push({ tone: 'support', text: `Over 7 days the price is ${formatPp(change7d)}.` });
    }
  }

  switch (volume.level) {
    case 'VERY_HIGH':
    case 'HIGH':
      factors.push({ tone: 'support', text: `24h volume is ${formatRatio(volume.ratio)} the recent daily average (${formatUsd(volume.volume24h)}).` });
      break;
    case 'NORMAL':
      factors.push({ tone: 'support', text: `Volume is in line with the recent daily average (${formatRatio(volume.ratio)}).` });
      break;
    case 'LOW':
      factors.push({
        tone: 'caution',
        text: isFiniteNumber(volume.ratio)
          ? `Volume is below the recent daily average (${formatRatio(volume.ratio)}), so less trading backs the price.`
          : 'There has been little or no trading recently.',
      });
      break;
    case 'UNKNOWN':
      factors.push({ tone: 'caution', text: 'Volume data is incomplete.' });
      break;
  }

  switch (liquidity.level) {
    case 'HIGH':
      factors.push({ tone: 'support', text: `Deep liquidity (${formatUsd(liquidity.usd)}): single trades move the price less.` });
      break;
    case 'MEDIUM':
      factors.push({ tone: 'support', text: `Moderate liquidity (${formatUsd(liquidity.usd)}).` });
      break;
    case 'LOW':
      factors.push({ tone: 'caution', text: `Low liquidity (${formatUsd(liquidity.usd)}): the price reacts more to single trades.` });
      break;
    case 'UNKNOWN':
      factors.push({ tone: 'caution', text: 'Liquidity is unknown.' });
      break;
  }

  if (volatility.level === 'ELEVATED' || volatility.level === 'EXTREME') {
    factors.push({
      tone: 'caution',
      text: `The price has been ${volatility.level === 'EXTREME' ? 'very ' : ''}choppy (hourly swings of about ${volatility.hourlyPp?.toFixed(1)} pp), which weakens the signal.`,
    });
  }

  if (!input.hasHistory) factors.push({ tone: 'caution', text: 'No price history available for this market.' });

  return factors;
}
