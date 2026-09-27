import { highestPriced } from '../core/probability';
import { normalizeQuery } from '../core/search';
import type { HistoryRange, Market, MarketContext, MarketEvent, MarketRef, Outcome, PricePoint, SearchResult } from '../core/types';
import { TtlCache, type Fetched } from './cache';
import { historyUrl, parsePriceHistory } from './clob';
import { DataError } from './errors';
import { firstOfList, parentEventSlug, parseGammaEvent, parseGammaMarket, parseSearchResponse, type ParsedEvent } from './gamma';
import { getJson, type FetchLike } from './http';

/**
 * Market data behind an interface, so the UI and the analysis engine never depend on
 * Polymarket's API. Everything returned is normalized (src/core/types.ts).
 */
export interface MarketDataService {
  /** The market (or multi-outcome event) a page points at. */
  getCurrentMarket(ref: MarketRef, options?: RequestOptions): Promise<Fetched<MarketContext>>;
  /** Price history of a market's first outcome ("Yes"). */
  getMarketHistory(market: Market, range: HistoryRange, options?: RequestOptions): Promise<Fetched<PricePoint[]>>;
  getMarketVolume(ref: MarketRef, options?: RequestOptions): Promise<{ volume24h: number | null; volume7d: number | null; volumeTotal: number | null }>;
  getMarketLiquidity(ref: MarketRef, options?: RequestOptions): Promise<number | null>;
  getMarketOutcomes(ref: MarketRef, options?: RequestOptions): Promise<Outcome[]>;
  searchMarkets(query: string, options?: { signal?: AbortSignal; limit?: number }): Promise<SearchResult[]>;
}

export interface RequestOptions {
  /** Skip the cache (manual refresh). */
  force?: boolean;
  signal?: AbortSignal;
}

export interface PolymarketServiceConfig {
  gammaBase: string;
  clobBase: string;
  fetch: FetchLike;
  cache: TtlCache;
}

export class PolymarketService implements MarketDataService {
  constructor(private readonly config: PolymarketServiceConfig) {}

  async getCurrentMarket(ref: MarketRef, options: RequestOptions = {}): Promise<Fetched<MarketContext>> {
    if (!ref.eventSlug && !ref.marketSlug) throw new DataError('NOT_FOUND', 'No market reference');

    if (ref.eventSlug) {
      const fetched = await this.fetchEvent(ref.eventSlug, options);
      return { ...fetched, data: await this.contextFromEvent(fetched.data, ref.marketSlug, options) };
    }

    const fetched = await this.cached(`gamma:market:${ref.marketSlug}`, `${this.config.gammaBase}/markets?${new URLSearchParams({ slug: ref.marketSlug! })}`, options, (raw) =>
      parseGammaMarket(firstOfList(raw)),
    );
    const rawMarket = firstOfList(fetched.data);
    const market = requireAnalyzable(parseGammaMarket(rawMarket));
    // Related markets come from the parent event; without it the market is still analyzed.
    let event: MarketEvent | null = null;
    const eventSlug = parentEventSlug(rawMarket);
    if (eventSlug) {
      try {
        event = (await this.fetchEvent(eventSlug, { signal: options.signal })).data.event;
      } catch {
        event = null;
      }
    }
    return { ...fetched, data: { kind: 'binary', event, market } };
  }

  async getMarketHistory(market: Market, range: HistoryRange, options: RequestOptions = {}): Promise<Fetched<PricePoint[]>> {
    const tokenId = market.outcomes[0]?.tokenId;
    if (!tokenId) throw new DataError('MISSING_HISTORY', 'Market has no CLOB token id');
    const fetched = await this.cached(`clob:history:${tokenId}:${range}`, historyUrl(this.config.clobBase, tokenId, range), options, parsePriceHistory);
    return { ...fetched, data: parsePriceHistory(fetched.data) };
  }

  async getMarketVolume(ref: MarketRef, options?: RequestOptions) {
    const { market } = (await this.getCurrentMarket(ref, options)).data;
    return { volume24h: market.volume24h, volume7d: market.volume7d, volumeTotal: market.volumeTotal };
  }

  async getMarketLiquidity(ref: MarketRef, options?: RequestOptions): Promise<number | null> {
    return (await this.getCurrentMarket(ref, options)).data.market.liquidity;
  }

  async getMarketOutcomes(ref: MarketRef, options?: RequestOptions): Promise<Outcome[]> {
    return (await this.getCurrentMarket(ref, options)).data.market.outcomes;
  }

  async searchMarkets(query: string, options: { signal?: AbortSignal; limit?: number } = {}): Promise<SearchResult[]> {
    const q = normalizeQuery(query);
    if (!q) return [];
    const limit = options.limit ?? 10;
    // Assumed parameters: q (text) and limit_per_type (results per entity type).
    const params = new URLSearchParams({ q, limit_per_type: String(limit) });
    const raw = await getJson(`${this.config.gammaBase}/public-search?${params}`, {
      fetch: this.config.fetch,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return parseSearchResponse(raw, limit);
  }

  // --- internals ------------------------------------------------------------------------

  private async fetchEvent(slug: string, options: RequestOptions): Promise<Fetched<ParsedEvent>> {
    const fetched = await this.cached(`gamma:event:${slug}`, `${this.config.gammaBase}/events?${new URLSearchParams({ slug })}`, options, (raw) =>
      parseGammaEvent(firstOfList(raw)),
    );
    return { ...fetched, data: parseGammaEvent(firstOfList(fetched.data)) };
  }

  private async contextFromEvent(parsed: ParsedEvent, marketSlug: string | null, options: RequestOptions): Promise<MarketContext> {
    const { event, closed } = parsed;
    if (marketSlug) {
      const market = event.markets.find((candidate) => candidate.slug === marketSlug);
      if (market) return { kind: 'binary', event, market };
      if (closed.some((candidate) => candidate.slug === marketSlug)) throw closedError();
      // The market may have moved to another event; look it up directly.
      const direct = await this.getCurrentMarket({ eventSlug: null, marketSlug }, options);
      return direct.data;
    }
    if (event.markets.length === 0) {
      if (closed.length > 0) throw closedError();
      throw new DataError('UNSUPPORTED_MARKET', 'This event has no open markets with prices yet.');
    }
    if (event.markets.length === 1) return { kind: 'binary', event, market: event.markets[0]! };
    return { kind: 'multi', event, market: highestPriced(event.markets) ?? event.markets[0]! };
  }

  /**
   * Cached GET. The cache stores the raw JSON, and callers parse it again after reading, so
   * data read back from storage goes through the same validation as a fresh response.
   * `validate` runs before anything is stored, so malformed responses are never cached.
   */
  private cached(key: string, url: string, options: RequestOptions, validate: (raw: unknown) => unknown): Promise<Fetched<unknown>> {
    return this.config.cache.get(
      key,
      async () => {
        const raw = await getJson(url, { fetch: this.config.fetch, ...(options.signal ? { signal: options.signal } : {}) });
        validate(raw);
        return raw;
      },
      { force: options.force ?? false },
    );
  }
}

function requireAnalyzable(market: Market): Market {
  if (market.closed) throw closedError();
  if (market.probability === null) throw new DataError('UNSUPPORTED_MARKET', 'This market has no price yet, so there is nothing to analyze.');
  return market;
}

function closedError(): DataError {
  return new DataError('UNSUPPORTED_MARKET', 'This market is closed. The analysis covers open markets only.');
}
