import { formatPp, formatRatio, formatUsd } from './format';
import type { LiquidityLevel, VolumeActivity } from './metrics';
import { isFiniteNumber, toPp } from './numbers';

/**
 * Unusual activity: purely informational flags built from the numbers. They never
 * speculate about causes (news, insiders, whales); they only say what the data shows.
 *
 * Thresholds:
 *   LARGE_MOVE        |24h change| ≥ 10 pp
 *   VOLUME_SPIKE      24h volume ≥ 3× the 7-day daily average
 *   MOVE_WITH_SPIKE   |24h change| ≥ 5 pp and volume ≥ 2× average (replaces the two above)
 *   REVERSAL          |24h change| ≥ 3 pp against a ≥ 3 pp move over the 6 days before
 *   SUDDEN_MOVE       a single hour moved ≥ 5 pp within the last 24 h (from price history)
 *   LOW_LIQUIDITY_MOVE |24h change| ≥ 5 pp while liquidity is LOW
 */
export const UNUSUAL_THRESHOLDS = {
  largeMovePp: 10,
  volumeSpikeRatio: 3,
  comboMovePp: 5,
  comboVolumeRatio: 2,
  reversalPp: 3,
  suddenMovePp: 5,
  lowLiquidityMovePp: 5,
} as const;

export type UnusualKind = 'MOVE_WITH_SPIKE' | 'LARGE_MOVE' | 'VOLUME_SPIKE' | 'REVERSAL' | 'SUDDEN_MOVE' | 'LOW_LIQUIDITY_MOVE';

export interface UnusualSignal {
  kind: UnusualKind;
  title: string;
  detail: string;
}

export interface UnusualInput {
  change24h: number | null;
  change7d: number | null;
  volume: VolumeActivity;
  liquidity: { level: LiquidityLevel; usd: number | null };
  /** Largest single-hour change in the last 24 h (signed, probability units), if history exists. */
  largestHourlyMove: number | null;
}

export function detectUnusualActivity(input: UnusualInput): UnusualSignal[] {
  const signals: UnusualSignal[] = [];
  const t = UNUSUAL_THRESHOLDS;
  const move = isFiniteNumber(input.change24h) ? toPp(input.change24h) : null;
  const ratio = input.volume.ratio;
  const absMove = move === null ? null : Math.abs(move);

  const combo = absMove !== null && absMove >= t.comboMovePp && isFiniteNumber(ratio) && ratio >= t.comboVolumeRatio;
  if (combo) {
    signals.push({
      kind: 'MOVE_WITH_SPIKE',
      title: 'Price move on heavy volume',
      detail: `${formatPp(input.change24h)} in 24h on ${formatRatio(ratio)} the average daily volume.`,
    });
  } else {
    if (absMove !== null && absMove >= t.largeMovePp) {
      signals.push({ kind: 'LARGE_MOVE', title: 'Large 24h move', detail: `${formatPp(input.change24h)} in the last 24 hours.` });
    }
    if (isFiniteNumber(ratio) && ratio >= t.volumeSpikeRatio) {
      signals.push({
        kind: 'VOLUME_SPIKE',
        title: 'Volume spike',
        detail: `24h volume ${formatUsd(input.volume.volume24h)} is ${formatRatio(ratio)} the average daily volume (${formatUsd(input.volume.averageDaily)}).`,
      });
    }
  }

  if (move !== null && isFiniteNumber(input.change7d)) {
    const prior = toPp(input.change7d) - move;
    if (Math.abs(move) >= t.reversalPp && Math.abs(prior) >= t.reversalPp && Math.sign(prior) !== Math.sign(move)) {
      signals.push({
        kind: 'REVERSAL',
        title: 'Sudden reversal',
        detail: `${formatPp(input.change24h)} in 24h after ${formatPp(prior / 100)} over the previous 6 days.`,
      });
    }
  }

  if (isFiniteNumber(input.largestHourlyMove) && Math.abs(toPp(input.largestHourlyMove)) >= t.suddenMovePp) {
    signals.push({
      kind: 'SUDDEN_MOVE',
      title: 'Sudden move',
      detail: `The price moved ${formatPp(input.largestHourlyMove)} within a single hour in the last 24 hours.`,
    });
  }

  if (absMove !== null && absMove >= t.lowLiquidityMovePp && input.liquidity.level === 'LOW') {
    signals.push({
      kind: 'LOW_LIQUIDITY_MOVE',
      title: 'Large move with low liquidity',
      detail: `${formatPp(input.change24h)} in 24h with only ${formatUsd(input.liquidity.usd)} of liquidity.`,
    });
  }

  return signals;
}
