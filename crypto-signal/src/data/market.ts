import { DEFAULT_ASSETS, isValidSymbol } from '../core/assets';
import { asObject } from '../core/sanitize';
import { validateCandles } from '../core/signal';
import {
  INTERVAL_MS,
  isFiniteNumber,
  isInterval,
  isProviderId,
  type Candle,
  type Interval,
  type ProviderId,
  type Ticker,
} from '../core/types';
import { BLOCKED_BACKOFF_MS, CACHE_TTL_MS, CANDLE_LIMIT } from './config';
import { isAbortError, MarketDataError, type MarketErrorCode } from './errors';
import { normalizeQuery, rankSymbols, type MarketDataProvider, type SymbolMatch } from './provider';

/**
 * Loads market data for one symbol and timeframe: cache first (60 s), then the providers in
 * order (Binance, then Coinbase). Remembers rate limits (Retry-After) and geo-blocks per provider
 * so it doesn't keep hitting a provider that said no. When every provider fails, older cached
 * data is returned as explicitly stale; without cache, an error. It never makes data up.
 */

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface MarketData {
  symbol: string;
  quote: string;
  source: ProviderId;
  interval: Interval;
  candles: Candle[];
  ticker: Ticker | null;
  fetchedAt: number;
}

export interface ProviderAttempt {
  provider: ProviderId;
  code: MarketErrorCode;
  status: number | null;
  /** True when the provider was skipped because of an earlier rate limit or block. */
  skipped: boolean;
}

export type LoadResult =
  | { status: 'fresh'; data: MarketData; fromCache: boolean; attempts: ProviderAttempt[] }
  | { status: 'stale'; data: MarketData; error: MarketDataError; attempts: ProviderAttempt[] }
  | { status: 'error'; error: MarketDataError; attempts: ProviderAttempt[] };

export interface SearchResult {
  matches: SymbolMatch[];
  source: ProviderId | null;
  error: MarketDataError | null;
}

interface ProviderHealth {
  blockedUntil?: number;
  rateLimitedUntil?: number;
}

export const CACHE_PREFIX = 'market:v1:';
const CACHE_INDEX_KEY = 'market:v1:index';
const HEALTH_KEY = 'providers:v1:health';
const MAX_CACHE_ENTRIES = 24;

/** Oldest cached data shown (as stale) when refreshing fails: two candles, at least 30 minutes. */
export function maxStaleAge(interval: Interval): number {
  return Math.max(30 * 60 * 1000, 2 * INTERVAL_MS[interval]);
}

export interface MarketServiceOptions {
  providers: readonly MarketDataProvider[];
  store: KeyValueStore;
  now?: () => number;
  ttlMs?: number;
  candleLimit?: number;
}

export class MarketService {
  private readonly providers: readonly MarketDataProvider[];
  private readonly store: KeyValueStore;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly candleLimit: number;

  constructor(options: MarketServiceOptions) {
    if (!options.providers.length) throw new Error('At least one provider is required');
    this.providers = options.providers;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.candleLimit = options.candleLimit ?? CANDLE_LIMIT;
  }

  /** `force` skips the cache (manual refresh). Rate limits and blocks are still respected. */
  async load(symbol: string, interval: Interval, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<LoadResult> {
    const key = cacheKey(symbol, interval);
    const cached = await this.readCache(key, symbol, interval);
    const started = this.now();
    if (!options.force && cached && started - cached.fetchedAt < this.ttlMs) {
      return { status: 'fresh', data: cached, fromCache: true, attempts: [] };
    }

    const health = await this.readHealth();
    const errors: MarketDataError[] = [];
    const attempts: ProviderAttempt[] = [];

    for (const provider of this.providers) {
      const state = health[provider.id] ?? {};
      const now = this.now();
      if (state.rateLimitedUntil && state.rateLimitedUntil > now) {
        const error = new MarketDataError('rate-limited', `${provider.label} is rate limiting requests.`, provider.id, 429, state.rateLimitedUntil - now);
        errors.push(error);
        attempts.push({ provider: provider.id, code: error.code, status: 429, skipped: true });
        continue;
      }
      if (state.blockedUntil && state.blockedUntil > now) {
        const error = new MarketDataError('blocked', `${provider.label} is not available from this location.`, provider.id);
        errors.push(error);
        attempts.push({ provider: provider.id, code: error.code, status: null, skipped: true });
        continue;
      }

      try {
        const { data, tickerError } = await this.fetchFrom(provider, symbol, interval, options.signal);
        await this.writeCache(key, data);
        let healthChanged = false;
        if (health[provider.id]) {
          delete health[provider.id];
          healthChanged = true;
        }
        if (tickerError && this.remember(health, provider.id, tickerError)) healthChanged = true;
        if (healthChanged) await this.writeHealth(health);
        return { status: 'fresh', data, fromCache: false, attempts };
      } catch (caught) {
        if (isAbortError(caught)) throw caught;
        const error = toMarketError(caught, provider.id);
        errors.push(error);
        attempts.push({ provider: provider.id, code: error.code, status: error.status, skipped: false });
        if (this.remember(health, provider.id, error)) await this.writeHealth(health);
      }
    }

    const error = pickError(errors);
    if (cached && this.now() - cached.fetchedAt <= maxStaleAge(interval)) {
      return { status: 'stale', data: cached, error, attempts };
    }
    return { status: 'error', error, attempts };
  }

  /** True when load() would be answered from the cache without a request. */
  async hasFresh(symbol: string, interval: Interval): Promise<boolean> {
    const cached = await this.readCache(cacheKey(symbol, interval), symbol, interval);
    return cached !== null && this.now() - cached.fetchedAt < this.ttlMs;
  }

  /** Searches the first provider that answers; falls back to the built-in coin list. */
  async search(query: string): Promise<SearchResult> {
    const q = normalizeQuery(query);
    const local = rankSymbols(DEFAULT_ASSETS.map((asset) => asset.symbol), q);
    if (!q) return { matches: [], source: null, error: null };
    const health = await this.readHealth();
    let lastError: MarketDataError | null = null;
    for (const provider of this.providers) {
      const state = health[provider.id] ?? {};
      const now = this.now();
      if ((state.rateLimitedUntil ?? 0) > now || (state.blockedUntil ?? 0) > now) continue;
      try {
        return { matches: await provider.searchSymbols(q), source: provider.id, error: null };
      } catch (caught) {
        lastError = toMarketError(caught, provider.id);
        if (this.remember(health, provider.id, lastError)) await this.writeHealth(health);
      }
    }
    return {
      matches: local,
      source: null,
      error: lastError ?? new MarketDataError('unavailable', 'No market data provider is reachable right now.'),
    };
  }

  /** Forgets cached market data and provider back-offs. */
  async clear(): Promise<void> {
    const index = await this.readIndex();
    await Promise.all([...index.map((key) => this.store.remove(key)), this.store.remove(CACHE_INDEX_KEY), this.store.remove(HEALTH_KEY)]);
  }

  /** Seconds until each provider may be asked again (for UI countdowns); empty when none are waiting. */
  async cooldowns(): Promise<Partial<Record<ProviderId, number>>> {
    const health = await this.readHealth();
    const now = this.now();
    const out: Partial<Record<ProviderId, number>> = {};
    for (const [id, state] of Object.entries(health) as [ProviderId, ProviderHealth][]) {
      const until = Math.max(state.rateLimitedUntil ?? 0, state.blockedUntil ?? 0);
      if (until > now) out[id] = until - now;
    }
    return out;
  }

  private async fetchFrom(
    provider: MarketDataProvider,
    symbol: string,
    interval: Interval,
    signal?: AbortSignal,
  ): Promise<{ data: MarketData; tickerError: MarketDataError | null }> {
    let tickerError: MarketDataError | null = null;
    const [candles, ticker] = await Promise.all([
      provider.getCandles(symbol, interval, this.candleLimit, signal),
      // The 24h ticker is a nice-to-have: without it the price comes from the latest candle.
      provider.getTicker(symbol, signal).catch((error: unknown) => {
        if (isAbortError(error)) throw error;
        tickerError = toMarketError(error, provider.id);
        return null;
      }),
    ]);
    if (!candles.length) throw new MarketDataError('invalid-symbol', `${provider.label} has no candles for this market.`, provider.id);
    const data: MarketData = { symbol, quote: provider.quote, source: provider.id, interval, candles, ticker, fetchedAt: this.now() };
    return { data, tickerError };
  }

  /** Records rate limits and blocks. Returns true when health changed. */
  private remember(health: Partial<Record<ProviderId, ProviderHealth>>, id: ProviderId, error: MarketDataError): boolean {
    const now = this.now();
    if (error.code === 'rate-limited') {
      health[id] = { ...health[id], rateLimitedUntil: now + (error.retryAfterMs ?? 60_000) };
      return true;
    }
    if (error.code === 'blocked') {
      health[id] = { ...health[id], blockedUntil: now + BLOCKED_BACKOFF_MS };
      return true;
    }
    return false;
  }

  // --- Storage --------------------------------------------------------------------------

  private async readCache(key: string, symbol: string, interval: Interval): Promise<MarketData | null> {
    try {
      const entry = deserializeMarketData(await this.store.get(key), this.now());
      return entry && entry.symbol === symbol && entry.interval === interval ? entry : null;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, data: MarketData): Promise<void> {
    try {
      await this.store.set(key, serializeMarketData(data));
      const index = [key, ...(await this.readIndex()).filter((existing) => existing !== key)];
      const evicted = index.slice(MAX_CACHE_ENTRIES);
      await this.store.set(CACHE_INDEX_KEY, index.slice(0, MAX_CACHE_ENTRIES));
      await Promise.all(evicted.map((old) => this.store.remove(old)));
    } catch {
      // The cache is an optimization; a failed write must not fail the analysis.
    }
  }

  private async readIndex(): Promise<string[]> {
    try {
      const raw = await this.store.get(CACHE_INDEX_KEY);
      return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === 'string' && key.startsWith(CACHE_PREFIX)) : [];
    } catch {
      return [];
    }
  }

  private async readHealth(): Promise<Partial<Record<ProviderId, ProviderHealth>>> {
    try {
      const raw = asObject(await this.store.get(HEALTH_KEY)) ?? {};
      const health: Partial<Record<ProviderId, ProviderHealth>> = {};
      for (const [id, value] of Object.entries(raw)) {
        const state = asObject(value);
        if (!isProviderId(id) || !state) continue;
        const entry: ProviderHealth = {};
        if (isFiniteNumber(state.blockedUntil)) entry.blockedUntil = state.blockedUntil;
        if (isFiniteNumber(state.rateLimitedUntil)) entry.rateLimitedUntil = state.rateLimitedUntil;
        health[id] = entry;
      }
      return health;
    } catch {
      return {};
    }
  }

  private async writeHealth(health: Partial<Record<ProviderId, ProviderHealth>>): Promise<void> {
    try {
      await this.store.set(HEALTH_KEY, health);
    } catch {
      // Best effort.
    }
  }
}

export function cacheKey(symbol: string, interval: Interval): string {
  return `${CACHE_PREFIX}${symbol}:${interval}`;
}

/**
 * The most useful error to show when every provider failed. A rate limit or an outage says
 * "try again later", which beats "not listed" from a fallback that simply lacks the coin.
 * Only when every provider says "not listed" is the symbol reported as invalid.
 */
export function pickError(errors: readonly MarketDataError[]): MarketDataError {
  if (!errors.length) return new MarketDataError('unavailable', 'No market data provider is configured.');
  const order: MarketErrorCode[] = ['rate-limited', 'network', 'timeout', 'unavailable', 'blocked', 'malformed', 'invalid-symbol'];
  for (const code of order) {
    const matching = errors.filter((error) => error.code === code);
    if (!matching.length) continue;
    if (code === 'rate-limited') {
      return matching.reduce((best, error) => ((error.retryAfterMs ?? Infinity) < (best.retryAfterMs ?? Infinity) ? error : best));
    }
    return matching[0]!;
  }
  return errors[0]!;
}

function toMarketError(error: unknown, provider: ProviderId): MarketDataError {
  if (error instanceof MarketDataError) return error;
  return new MarketDataError('malformed', 'Unexpected error while reading market data.', provider);
}

// --- Serialization (compact rows keep chrome.storage.session small) ---------------------

type CandleRow = [number, number, number, number, number, number];

export function serializeMarketData(data: MarketData): unknown {
  return {
    symbol: data.symbol,
    quote: data.quote,
    source: data.source,
    interval: data.interval,
    fetchedAt: data.fetchedAt,
    ticker: data.ticker,
    candles: data.candles.map((c): CandleRow => [c.openTime, c.open, c.high, c.low, c.close, c.volume]),
  };
}

/** Rebuilds cached data, or null when anything about it is off. */
export function deserializeMarketData(raw: unknown, now: number): MarketData | null {
  const entry = asObject(raw);
  if (!entry) return null;
  const { symbol, quote, source, interval, fetchedAt, ticker, candles } = entry;
  if (!isValidSymbol(symbol) || typeof quote !== 'string' || !/^[A-Z]{3,5}$/.test(quote)) return null;
  if (!isProviderId(source) || !isInterval(interval) || !isFiniteNumber(fetchedAt) || fetchedAt > now + 60_000) return null;
  if (!Array.isArray(candles)) return null;
  const duration = INTERVAL_MS[interval];
  const rows: Candle[] = [];
  for (const row of candles) {
    if (!Array.isArray(row) || row.length !== 6 || !row.every(isFiniteNumber)) return null;
    const [openTime, open, high, low, close, volume] = row as CandleRow;
    rows.push({ openTime, closeTime: openTime + duration, open, high, low, close, volume });
  }
  if (!rows.length || validateCandles(rows)) return null;
  let parsedTicker: Ticker | null = null;
  if (ticker !== null) {
    const t = asObject(ticker);
    if (!t || !isFiniteNumber(t.lastPrice) || t.lastPrice <= 0) return null;
    if (t.changePct24h !== null && !isFiniteNumber(t.changePct24h)) return null;
    parsedTicker = { lastPrice: t.lastPrice, changePct24h: t.changePct24h as number | null };
  }
  return { symbol, quote, source, interval, fetchedAt, ticker: parsedTicker, candles: rows };
}
