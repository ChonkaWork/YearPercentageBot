/**
 * Internal, normalized market model. The analysis engine and the UI only ever see these
 * types; Polymarket's response shapes stay inside src/data/.
 *
 * Conventions:
 * - Probabilities and prices are in [0, 1].
 * - Price changes are in probability units (0.05 = +5 percentage points).
 * - Timestamps are milliseconds since the epoch.
 * - Money is USD. Every number is finite or null (unknown), never NaN/Infinity/undefined.
 */

export interface Outcome {
  name: string;
  /** Market price of this outcome, read as its implied probability. Null when missing/invalid. */
  probability: number | null;
  /** CLOB token id (needed for price history). */
  tokenId: string | null;
}

export interface Market {
  id: string;
  slug: string;
  question: string;
  /** Short label of this market inside a multi-market event (e.g. "17–19 storms"). */
  label: string | null;
  /** At least two outcomes. For Yes/No markets outcomes[0] is "Yes". */
  outcomes: Outcome[];
  /** Price of outcomes[0]. This is the number all changes and momentum refer to. */
  probability: number | null;
  change24h: number | null;
  change7d: number | null;
  volume24h: number | null;
  volume7d: number | null;
  volumeTotal: number | null;
  liquidity: number | null;
  startDate: number | null;
  endDate: number | null;
  closed: boolean;
}

export interface MarketEvent {
  id: string;
  slug: string;
  title: string;
  /** True when exactly one market in the event can resolve Yes (outcome prices should sum to ~1). */
  mutuallyExclusive: boolean;
  /** Open, readable markets of the event. */
  markets: Market[];
  /** Markets left out because they're closed or unreadable. */
  hiddenMarkets: number;
  volume24h: number | null;
  liquidity: number | null;
  endDate: number | null;
}

export type MarketKind = 'binary' | 'multi';

/** What the popup analyzes: one market, optionally inside its event. */
export interface MarketContext {
  kind: MarketKind;
  event: MarketEvent | null;
  /** The market the page points at, or for a multi-outcome event the current leader. */
  market: Market;
}

/** Reference to a market as found in a URL or a saved item. */
export interface MarketRef {
  eventSlug: string | null;
  marketSlug: string | null;
}

export interface PricePoint {
  /** ms since epoch */
  t: number;
  /** price in [0, 1] */
  p: number;
}

export const HISTORY_RANGES = ['24h', '7d', '30d'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === 'string' && (HISTORY_RANGES as readonly string[]).includes(value);
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface SearchResult {
  eventSlug: string;
  title: string;
  /** Number of open markets in the event. */
  marketCount: number;
  /** For single-market events: price of the first outcome and its name. */
  probability: number | null;
  outcomeName: string | null;
  /** For multi-market events: the highest-priced market. */
  leader: { label: string; probability: number } | null;
  volume24h: number | null;
  endDate: number | null;
}
