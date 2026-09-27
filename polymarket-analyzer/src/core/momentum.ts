import type { LiquidityLevel, VolatilityLevel, VolumeLevel } from './metrics';
import { clamp, isFiniteNumber, sign, toPp } from './numbers';

/**
 * Momentum describes recent price movement. It says nothing about how likely the event is.
 *
 * 1. Score the 24h change (percentage points):
 *      > +5 → +3 · +2..+5 → +2 · +0.5..+2 → +1 · −0.5..+0.5 → 0 · mirrored for drops
 * 2. The 7d trend adds +1 (7d change > +0.5 pp) or −1 (< −0.5 pp).
 * 3. HIGH or VERY HIGH volume adds 1 point in the direction of the score (never flips it).
 *    Result: −5..+5.
 * 4. Label: ≥ +4 strong positive, +1..+3 positive, 0 neutral, mirrored for negative.
 * 5. Strength (0–100) = |score| / 5, scaled down by
 *      liquidity  (HIGH 1.0 · MEDIUM 0.85 · LOW 0.6 · unknown 0.7) — thin books make moves less telling
 *      volatility (NORMAL 1.0 · ELEVATED 0.85 · EXTREME 0.65 · unknown 1.0) — choppy prices blur trends
 *      volume     (LOW 0.85, otherwise 1.0) — moves on little trading are weaker evidence
 */

export const SIGNAL_LABELS = ['STRONG_POSITIVE', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'STRONG_NEGATIVE'] as const;
export type SignalLabel = (typeof SIGNAL_LABELS)[number];

export function isSignalLabel(value: unknown): value is SignalLabel {
  return typeof value === 'string' && (SIGNAL_LABELS as readonly string[]).includes(value);
}

export const SIGNAL_TEXT: Record<SignalLabel, string> = {
  STRONG_POSITIVE: 'STRONG POSITIVE MOMENTUM',
  POSITIVE: 'POSITIVE MOMENTUM',
  NEUTRAL: 'NEUTRAL',
  NEGATIVE: 'NEGATIVE MOMENTUM',
  STRONG_NEGATIVE: 'STRONG NEGATIVE MOMENTUM',
};

export function signalDirection(label: SignalLabel | null): 'up' | 'down' | 'flat' {
  if (label === 'STRONG_POSITIVE' || label === 'POSITIVE') return 'up';
  if (label === 'STRONG_NEGATIVE' || label === 'NEGATIVE') return 'down';
  return 'flat';
}

export const LIQUIDITY_FACTOR: Record<LiquidityLevel, number> = { HIGH: 1, MEDIUM: 0.85, LOW: 0.6, UNKNOWN: 0.7 };
export const VOLATILITY_FACTOR: Record<VolatilityLevel, number> = { NORMAL: 1, ELEVATED: 0.85, EXTREME: 0.65, UNKNOWN: 1 };
export const LOW_VOLUME_FACTOR = 0.85;
export const TREND_DEADBAND_PP = 0.5;
const MAX_SCORE = 5;

/** Step 1: score of the 24h change in percentage points. */
export function changeScore(changePp: number): -3 | -2 | -1 | 0 | 1 | 2 | 3 {
  if (changePp > 5) return 3;
  if (changePp >= 2) return 2;
  if (changePp >= 0.5) return 1;
  if (changePp > -0.5) return 0;
  if (changePp > -2) return -1;
  if (changePp >= -5) return -2;
  return -3;
}

/** Step 2: the 7d trend adjustment. */
export function trendAdjustment(change7dPp: number | null): -1 | 0 | 1 {
  if (change7dPp === null) return 0;
  if (change7dPp > TREND_DEADBAND_PP) return 1;
  if (change7dPp < -TREND_DEADBAND_PP) return -1;
  return 0;
}

export function labelForScore(score: number): SignalLabel {
  if (score >= 4) return 'STRONG_POSITIVE';
  if (score >= 1) return 'POSITIVE';
  if (score <= -4) return 'STRONG_NEGATIVE';
  if (score <= -1) return 'NEGATIVE';
  return 'NEUTRAL';
}

export interface MomentumInput {
  /** Probability units. */
  change24h: number | null;
  change7d: number | null;
  volume: VolumeLevel;
  liquidity: LiquidityLevel;
  volatility: VolatilityLevel;
}

export interface Momentum {
  /** Null when there isn't enough data (no 24h change). */
  label: SignalLabel | null;
  /** −5..+5 */
  score: number | null;
  /** 0..100 */
  strength: number | null;
  components: {
    change24h: number;
    trend7d: number;
    volume: number;
    liquidityFactor: number;
    volatilityFactor: number;
    volumeFactor: number;
  } | null;
}

export function computeMomentum(input: MomentumInput): Momentum {
  if (!isFiniteNumber(input.change24h)) return { label: null, score: null, strength: null, components: null };
  const change24hScore = changeScore(toPp(input.change24h));
  const trend = trendAdjustment(isFiniteNumber(input.change7d) ? toPp(input.change7d) : null);
  const base = change24hScore + trend;
  const volumeBonus = base !== 0 && (input.volume === 'HIGH' || input.volume === 'VERY_HIGH') ? sign(base) : 0;
  const score = clamp(base + volumeBonus, -MAX_SCORE, MAX_SCORE);

  const liquidityFactor = LIQUIDITY_FACTOR[input.liquidity];
  const volatilityFactor = VOLATILITY_FACTOR[input.volatility];
  const volumeFactor = input.volume === 'LOW' ? LOW_VOLUME_FACTOR : 1;
  const strength = Math.round((100 * Math.abs(score)) / MAX_SCORE * liquidityFactor * volatilityFactor * volumeFactor);

  return {
    label: labelForScore(score),
    score,
    strength: clamp(strength, 0, 100),
    components: { change24h: change24hScore, trend7d: trend, volume: volumeBonus, liquidityFactor, volatilityFactor, volumeFactor },
  };
}
