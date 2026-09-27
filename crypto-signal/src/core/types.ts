/** Chart timeframes the extension offers. */
export const INTERVALS = ['1h', '4h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Readonly<Record<Interval, number>> = Object.freeze({
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
});

export function isInterval(value: unknown): value is Interval {
  return typeof value === 'string' && (INTERVALS as readonly string[]).includes(value);
}

/** One OHLCV candle, normalized across providers. Times are epoch milliseconds. */
export interface Candle {
  openTime: number;
  /** Exclusive end of the candle: openTime + interval length. */
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Traded volume in the base asset. */
  volume: number;
}

/** Latest price plus the rolling 24h change, when the provider has one. */
export interface Ticker {
  lastPrice: number;
  /** Percent, e.g. 2.5 for +2.5%. Null when the provider doesn't report it. */
  changePct24h: number | null;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Market-data sources. */
export const PROVIDER_IDS = ['binance', 'coinbase'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = Object.freeze({
  binance: 'Binance',
  coinbase: 'Coinbase Exchange',
});

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}
