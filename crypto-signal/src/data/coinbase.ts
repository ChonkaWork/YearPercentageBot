import { isValidSymbol } from '../core/assets';
import { validateCandles } from '../core/signal';
import { INTERVAL_MS, type Candle, type Interval, type Ticker } from '../core/types';
import { API_ORIGINS } from './config';
import { MarketDataError } from './errors';
import { commonStatusError, getJson, parseDecimal, type HttpOptions, type HttpResponse } from './http';
import { rankSymbols, type MarketDataProvider, type SymbolMatch } from './provider';

/**
 * Coinbase Exchange public market data (no API key), used when Binance is unavailable.
 * Documented at https://docs.cdp.coinbase.com/exchange/reference/
 *
 *   GET /products/BTC-USD/candles?granularity=3600   → [[time, low, high, open, close, volume], …] newest first, ≤ 300
 *   GET /products/BTC-USD/stats                      → {open, high, low, last, volume, …} over 24 h
 *   GET /products                                    → [{id, base_currency, quote_currency, status, …}]
 *
 * Granularities are 60, 300, 900, 3600, 21600 and 86400 seconds; there is no 4-hour candle,
 * so 4h candles are built from hourly ones. Errors look like {"message": "NotFound"}.
 */
export class CoinbaseProvider implements MarketDataProvider {
  readonly id = 'coinbase' as const;
  readonly label = 'Coinbase';
  readonly quote = 'USD';
  private productList: Promise<string[]> | null = null;

  constructor(
    private readonly baseUrl: string = API_ORIGINS.coinbase,
    private readonly http: HttpOptions = {},
  ) {}

  async getCandles(symbol: string, interval: Interval, limit: number, signal?: AbortSignal): Promise<Candle[]> {
    const granularity = interval === '1d' ? 86_400 : 3_600;
    const response = await this.get(`/products/${this.product(symbol)}/candles?granularity=${granularity}`, signal);
    const candles = parseCoinbaseCandles(response.body, granularity);
    const result = interval === '4h' ? aggregateCandles(candles, INTERVAL_MS['4h']) : candles;
    return result.slice(-limit);
  }

  async getTicker(symbol: string, signal?: AbortSignal): Promise<Ticker> {
    const response = await this.get(`/products/${this.product(symbol)}/stats`, signal);
    return parseCoinbaseStats(response.body);
  }

  async searchSymbols(query: string): Promise<SymbolMatch[]> {
    // The list is fetched once per session and shared by every search, so it isn't tied to one caller's abort signal.
    if (!this.productList) {
      this.productList = this.get('/products').then((response) => parseCoinbaseProducts(response.body, this.quote));
      this.productList.catch(() => {
        this.productList = null;
      });
    }
    return rankSymbols(await this.productList, query);
  }

  private product(symbol: string): string {
    const base = symbol.toUpperCase();
    if (!isValidSymbol(base)) throw new MarketDataError('invalid-symbol', `${symbol} is not a valid ticker.`, this.id);
    return `${base}-${this.quote}`;
  }

  private async get(path: string, signal?: AbortSignal): Promise<HttpResponse> {
    const now = (this.http.now ?? Date.now)();
    const response = await getJson(`${this.baseUrl}${path}`, this.id, { ...this.http, signal });
    const common = commonStatusError(response, this.id, this.label, now);
    if (common) throw common;
    if (response.status === 404 || response.status === 400) {
      const message = String((response.body as { message?: unknown } | undefined)?.message ?? '');
      if (response.status === 404 || /product/i.test(message)) {
        throw new MarketDataError('invalid-symbol', 'Coinbase does not list this market.', this.id, response.status);
      }
      throw new MarketDataError('unavailable', 'Coinbase rejected the request.', this.id, response.status);
    }
    return response;
  }
}

function malformed(detail: string): MarketDataError {
  return new MarketDataError('malformed', `Coinbase returned unexpected data (${detail}).`, 'coinbase');
}

/** [[time (s), low, high, open, close, volume], …] in any order → candles oldest first. */
export function parseCoinbaseCandles(body: unknown, granularitySeconds: number): Candle[] {
  if (!Array.isArray(body)) throw malformed('candles is not an array');
  const duration = granularitySeconds * 1000;
  const candles = body.map((row, index): Candle => {
    if (!Array.isArray(row) || row.length < 6) throw malformed(`candle ${index} has the wrong shape`);
    const time = row[0];
    if (!Number.isSafeInteger(time)) throw malformed(`candle ${index} has a bad time`);
    const [low, high, open, close, volume] = [row[1], row[2], row[3], row[4], row[5]].map(parseDecimal);
    if (low == null || high == null || open == null || close == null || volume == null) throw malformed(`candle ${index} has a bad number`);
    const openTime = (time as number) * 1000;
    return { openTime, closeTime: openTime + duration, open, high, low, close, volume };
  });
  candles.sort((a, b) => a.openTime - b.openTime);
  const problem = validateCandles(candles);
  if (problem) throw malformed(problem);
  return candles;
}

/**
 * Combines candles into UTC-aligned buckets of `bucketMs` (4h buckets start at 00:00, 04:00, …
 * UTC like Binance's). A leading bucket that is missing its first candles is dropped; the last
 * bucket may be in progress, like any exchange's current candle.
 */
export function aggregateCandles(candles: readonly Candle[], bucketMs: number): Candle[] {
  const buckets: Candle[] = [];
  let current: Candle | null = null;
  for (const candle of candles) {
    const start = Math.floor(candle.openTime / bucketMs) * bucketMs;
    if (current && current.openTime === start) {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume += candle.volume;
      continue;
    }
    if (!current && candle.openTime !== start) continue; // partial leading bucket
    current = { openTime: start, closeTime: start + bucketMs, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume };
    buckets.push(current);
  }
  return buckets;
}

export function parseCoinbaseStats(body: unknown): Ticker {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw malformed('stats is not an object');
  const record = body as Record<string, unknown>;
  const last = parseDecimal(record.last);
  const open = parseDecimal(record.open);
  if (last === null || last <= 0) throw malformed('stats has no last price');
  const changePct24h = open !== null && open > 0 ? ((last - open) / open) * 100 : null;
  return { lastPrice: last, changePct24h };
}

/** Online, tradable products quoted in `quote` → their base tickers. */
export function parseCoinbaseProducts(body: unknown, quote: string): string[] {
  if (!Array.isArray(body)) throw malformed('products is not an array');
  const bases: string[] = [];
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue;
    const product = item as Record<string, unknown>;
    if (product.quote_currency !== quote || product.status !== 'online' || product.trading_disabled === true) continue;
    const base = typeof product.base_currency === 'string' ? product.base_currency.toUpperCase() : '';
    if (isValidSymbol(base)) bases.push(base);
  }
  return bases;
}
