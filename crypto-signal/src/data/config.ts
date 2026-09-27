/**
 * API origins. The production build talks to the public endpoints below (and the manifest
 * grants host access to exactly these origins). The e2e build replaces them at build time with
 * a local fixture server; that branch is compiled out of production.
 */
export const API_ORIGINS: Readonly<{ binance: string; coinbase: string }> = __E2E__
  ? { binance: `${__E2E_API_ORIGIN__}/binance`, coinbase: `${__E2E_API_ORIGIN__}/coinbase` }
  : { binance: 'https://api.binance.com', coinbase: 'https://api.exchange.coinbase.com' };

/** Candles requested per analysis. Enough history for EMA50 and a settled RSI. */
export const CANDLE_LIMIT = 200;

/** Market data younger than this is served from the cache. */
export const CACHE_TTL_MS = 60_000;

/** After a geo-block (451/403) the provider is skipped for this long. */
export const BLOCKED_BACKOFF_MS = 30 * 60 * 1000;
