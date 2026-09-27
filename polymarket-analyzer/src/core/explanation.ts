import type { Analysis } from './analyze';
import { formatPpMagnitude, formatProbability, formatRatio, formatUsd } from './format';
import { SIGNAL_TEXT } from './momentum';
import { isFiniteNumber, toPp } from './numbers';

/**
 * Plain-language explanation of an analysis.
 *
 * `AIExplanationService` is the seam for a language model later: an implementation gets the
 * same structured input and must follow the same rules (only the numbers given, no news,
 * people or causes, no predictions). The MVP ships `LocalExplanationService`, a deterministic
 * template generator that runs in the browser and makes no requests.
 */

export interface ExplanationInput {
  /** The market question or event title. */
  title: string;
  /** Name of the outcome the probability refers to ("Yes", "17–19", "Lakers"). */
  outcomeName: string;
  kind: 'binary' | 'multi';
  analysis: Analysis;
  /** Multi-outcome only: the highest-priced outcome and this outcome's rank. */
  leader?: { name: string; probability: number | null } | null;
  rank?: { position: number; of: number } | null;
}

export interface Explanation {
  sentences: string[];
  text: string;
  /** Who wrote it: 'local' templates or a model id. */
  source: 'local' | 'model';
}

export interface AIExplanationService {
  readonly id: string;
  explain(input: ExplanationInput): Promise<Explanation>;
}

export class LocalExplanationService implements AIExplanationService {
  readonly id = 'local-templates-v1';

  async explain(input: ExplanationInput): Promise<Explanation> {
    const sentences = generateLocalExplanation(input);
    return { sentences, text: sentences.join(' '), source: 'local' };
  }
}

/** 2–4 sentences built only from the numbers in the analysis. */
export function generateLocalExplanation(input: ExplanationInput): string[] {
  const { analysis } = input;
  const sentences: string[] = [];
  const name = `“${input.outcomeName}”`;
  const price = formatProbability(analysis.probability);

  // 1. Where the price is and how it moved.
  const moves = describeMoves(analysis.change24h, analysis.change7d);
  if (input.kind === 'multi' && input.leader && input.rank) {
    const opening =
      input.rank.position === 1
        ? `${name} is the highest-priced of ${input.rank.of} outcomes at ${price}`
        : `${name} is priced at ${price}, number ${input.rank.position} of ${input.rank.of} outcomes (the current market leader, “${input.leader.name}”, is at ${formatProbability(input.leader.probability)})`;
    sentences.push(`${opening}${moves ? `, ${moves}` : ''}.`);
  } else if (isFiniteNumber(analysis.probability)) {
    sentences.push(`The market prices ${name} at ${price}${moves ? `, ${moves}` : ''}.`);
  } else {
    sentences.push('The current price is not available in the market data.');
  }

  // 2. Volume.
  const volume = analysis.volume;
  if (volume.level === 'HIGH' || volume.level === 'VERY_HIGH') {
    sentences.push(
      `Trading over the last 24 hours (${formatUsd(volume.volume24h)}) is about ${formatRatio(volume.ratio)} the recent daily average, so more trading than usual is behind the current price.`,
    );
  } else if (volume.level === 'LOW') {
    sentences.push(
      isFiniteNumber(volume.ratio)
        ? `Trading over the last 24 hours is light (${formatRatio(volume.ratio)} the recent daily average), so the latest prices rest on fewer trades.`
        : 'There has been little or no trading recently, so the latest prices rest on few trades.',
    );
  } else if (volume.level === 'NORMAL') {
    sentences.push(`Trading volume over the last 24 hours (${formatUsd(volume.volume24h)}) is in line with the recent daily average.`);
  }

  // 3. Liquidity, or volatility when liquidity is unremarkable.
  const liquidity = analysis.liquidity;
  if (liquidity.level === 'LOW') {
    sentences.push(`Liquidity is low (${formatUsd(liquidity.usd)}), so individual trades can move the price noticeably.`);
  } else if (analysis.volatility.level === 'EXTREME' || analysis.volatility.level === 'ELEVATED') {
    sentences.push(`The price has been choppy, with typical hourly swings of about ${analysis.volatility.hourlyPp?.toFixed(1)} points.`);
  } else if (liquidity.level === 'HIGH') {
    sentences.push(`Liquidity is deep (${formatUsd(liquidity.usd)}), so single trades have less effect on the price.`);
  }

  // 4. What the signal means.
  const label = analysis.momentum.label;
  if (label) {
    const flagged = analysis.unusual.length > 0 ? ', with some unusual activity' : '';
    const signal =
      label === 'NEUTRAL'
        ? `Overall the recent price movement shows no clear direction${flagged}`
        : `Overall this reads as ${SIGNAL_TEXT[label].toLowerCase()} (${analysis.momentum.strength}/100)${flagged}`;
    sentences.push(`${signal}; that describes recent trading, not the chance that the outcome happens.`);
  }

  return sentences.slice(0, 4);
}

function describeMoves(change24h: number | null, change7d: number | null): string {
  const parts: string[] = [];
  if (isFiniteNumber(change24h)) {
    const pp = Number(toPp(change24h).toFixed(1));
    parts.push(pp === 0 ? 'unchanged over the last 24 hours' : `${pp > 0 ? 'up' : 'down'} ${formatPpMagnitude(change24h).replace(' pp', ' points')} over the last 24 hours`);
  }
  if (isFiniteNumber(change7d)) {
    const pp = Number(toPp(change7d).toFixed(1));
    const text = pp === 0 ? 'flat over 7 days' : `${pp > 0 ? 'up' : 'down'} ${formatPpMagnitude(change7d).replace(' pp', ' points')} over 7 days`;
    parts.push(parts.length ? `and ${text}` : text);
  }
  return parts.join(' ');
}
