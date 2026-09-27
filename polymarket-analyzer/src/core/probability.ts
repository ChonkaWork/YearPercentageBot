import { isFiniteNumber, toFiniteNumber } from './numbers';

/** Tolerance for floating point noise around the [0, 1] bounds (e.g. 1.0000000002). */
const BOUND_EPSILON = 1e-6;

/**
 * A price read as a probability. Accepts finite numbers and numeric strings in [0, 1].
 * Values outside the range are rejected (null), never rescaled: a price of 62 is not
 * silently turned into 62%.
 */
export function normalizeProbability(value: unknown): number | null {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  if (number < -BOUND_EPSILON || number > 1 + BOUND_EPSILON) return null;
  return Math.min(1, Math.max(0, number));
}

/**
 * A price change in probability units. Must lie in [-1, 1]; anything else is a data error.
 */
export function normalizeChange(value: unknown): number | null {
  const number = toFiniteNumber(value);
  if (number === null || Math.abs(number) > 1 + BOUND_EPSILON) return null;
  return Math.min(1, Math.max(-1, number));
}

export type OutcomeSumStatus = 'ok' | 'spread' | 'inconsistent' | 'incomplete' | 'not-applicable';

export interface OutcomeSumCheck {
  status: OutcomeSumStatus;
  /** Sum of the known prices, null when any price is missing. */
  sum: number | null;
}

/**
 * Sanity check for the prices of outcomes that are mutually exclusive and exhaustive
 * (Yes/No, or a winner-takes-all event). Their prices should add up to about 100%. Order
 * book prices include the bid/ask spread, so a few points either way are normal.
 *
 * - ok:           within ±3 pp of 100%
 * - spread:       90%–115%, usually spread or thin books
 * - inconsistent: anything else; the UI shows a data warning
 */
export function checkOutcomeSum(probabilities: readonly (number | null)[], mutuallyExclusive: boolean): OutcomeSumCheck {
  if (!mutuallyExclusive || probabilities.length < 2) return { status: 'not-applicable', sum: null };
  if (probabilities.some((value) => !isFiniteNumber(value))) return { status: 'incomplete', sum: null };
  const sum = (probabilities as number[]).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) <= 0.03) return { status: 'ok', sum };
  if (sum >= 0.9 && sum <= 1.15) return { status: 'spread', sum };
  return { status: 'inconsistent', sum };
}

/**
 * The highest-priced outcome ("current market leader"). Ties keep the original order.
 * Null when no outcome has a price.
 */
export function highestPriced<T extends { probability: number | null }>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (!isFiniteNumber(item.probability)) continue;
    if (best === null || item.probability > (best.probability as number)) best = item;
  }
  return best;
}

/** Sorted copy, highest probability first; unknown prices last. Stable for ties. */
export function sortByProbability<T extends { probability: number | null }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const pa = a.item.probability;
      const pb = b.item.probability;
      if (pa === null && pb === null) return a.index - b.index;
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa || a.index - b.index;
    })
    .map(({ item }) => item);
}
