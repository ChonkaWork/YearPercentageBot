import { clamp, isFiniteNumber, roundTo, standardDeviation } from './numbers';
import { hourlyChangesPp } from './series';
import { DAY_MS, type PricePoint } from './types';

// --- Liquidity ----------------------------------------------------------------------------

export type LiquidityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

/**
 * Liquidity thresholds in USD (Polymarket's `liquidity` figure for the market's order book):
 *   LOW    < $10,000     a few trades can move the price
 *   MEDIUM $10,000 – $100,000
 *   HIGH   ≥ $100,000
 */
export const LIQUIDITY_THRESHOLDS = { medium: 10_000, high: 100_000 } as const;

export const LOW_LIQUIDITY_WARNING = 'Price may be more sensitive to individual trades.';

export function classifyLiquidity(usd: number | null): LiquidityLevel {
  if (!isFiniteNumber(usd) || usd < 0) return 'UNKNOWN';
  if (usd < LIQUIDITY_THRESHOLDS.medium) return 'LOW';
  if (usd < LIQUIDITY_THRESHOLDS.high) return 'MEDIUM';
  return 'HIGH';
}

// --- Volume activity ----------------------------------------------------------------------

export type VolumeLevel = 'LOW' | 'NORMAL' | 'HIGH' | 'VERY_HIGH' | 'UNKNOWN';

export interface VolumeActivity {
  level: VolumeLevel;
  /** 24h volume divided by the average daily volume of the last 7 days. */
  ratio: number | null;
  averageDaily: number | null;
  volume24h: number | null;
}

/**
 * Ratio thresholds for 24h volume vs. the 7-day daily average:
 *   LOW < 0.5×, NORMAL 0.5–1.5×, HIGH 1.5–3×, VERY HIGH ≥ 3×
 */
export const VOLUME_THRESHOLDS = { normal: 0.5, high: 1.5, veryHigh: 3 } as const;

/**
 * Compares the last 24 hours of volume to the average day of the last 7 days (which includes
 * those 24 hours, so the ratio is at most 7). Markets younger than a week are averaged over
 * the days they have existed.
 */
export function volumeActivity(input: {
  volume24h: number | null;
  volume7d: number | null;
  marketAgeMs?: number | null;
}): VolumeActivity {
  const { volume24h, volume7d } = input;
  if (!isFiniteNumber(volume24h) || volume24h < 0 || !isFiniteNumber(volume7d) || volume7d < 0) {
    return { level: 'UNKNOWN', ratio: null, averageDaily: null, volume24h: isFiniteNumber(volume24h) ? volume24h : null };
  }
  const days = isFiniteNumber(input.marketAgeMs) && input.marketAgeMs > 0 ? clamp(input.marketAgeMs / DAY_MS, 1, 7) : 7;
  // The two figures are updated separately; the week can't have less volume than its last day.
  const weekly = Math.max(volume7d, volume24h);
  const averageDaily = weekly / days;
  if (averageDaily <= 0) return { level: 'LOW', ratio: null, averageDaily: 0, volume24h };
  const ratio = roundTo(volume24h / averageDaily, 4);
  let level: VolumeLevel = 'LOW';
  if (ratio >= VOLUME_THRESHOLDS.veryHigh) level = 'VERY_HIGH';
  else if (ratio >= VOLUME_THRESHOLDS.high) level = 'HIGH';
  else if (ratio >= VOLUME_THRESHOLDS.normal) level = 'NORMAL';
  return { level, ratio, averageDaily, volume24h };
}

// --- Volatility ---------------------------------------------------------------------------

export type VolatilityLevel = 'NORMAL' | 'ELEVATED' | 'EXTREME' | 'UNKNOWN';

export interface Volatility {
  level: VolatilityLevel;
  /** Standard deviation of hourly price changes, in percentage points. */
  hourlyPp: number | null;
}

/**
 * Volatility is the standard deviation of hourly price changes, measured in percentage
 * points. Absolute changes are used instead of relative returns because relative returns of
 * a probability explode near 0 (1% -> 2% is a +100% "return").
 *   NORMAL < 0.5 pp/h, ELEVATED 0.5–1.2 pp/h, EXTREME ≥ 1.2 pp/h. Needs at least 12 hourly changes.
 * (A calm, liquid market moves ~0.2–0.3 pp per hour; one 8 pp jump in a week of hourly data
 * alone lifts the figure to ~0.6 pp.)
 */
export const VOLATILITY_THRESHOLDS = { elevated: 0.5, extreme: 1.2, minSamples: 12 } as const;

export function measureVolatility(series: readonly PricePoint[] | null): Volatility {
  if (!series || series.length < 2) return { level: 'UNKNOWN', hourlyPp: null };
  const changes = hourlyChangesPp(series);
  if (changes.length < VOLATILITY_THRESHOLDS.minSamples) return { level: 'UNKNOWN', hourlyPp: null };
  const deviation = standardDeviation(changes);
  if (deviation === null) return { level: 'UNKNOWN', hourlyPp: null };
  const hourlyPp = roundTo(deviation, 4);
  const level: VolatilityLevel =
    hourlyPp >= VOLATILITY_THRESHOLDS.extreme ? 'EXTREME' : hourlyPp >= VOLATILITY_THRESHOLDS.elevated ? 'ELEVATED' : 'NORMAL';
  return { level, hourlyPp };
}
