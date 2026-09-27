import { validateCandles } from '../core/signal';
import { isValidSymbol } from '../core/assets';
import { INTERVAL_MS, type Candle, type Interval, type Ticker } from '../core/types';
import { API_ORIGINS } from './config';
import { MarketDataError } from './errors';
import { commonStatusError, getJson, parseDecimal, type HttpOptions, type HttpResponse } from './http';
import { rankSymbols, type MarketDataProvider, type SymbolMatch } from './provider';

/**
 * Binance Spot public market data (no API key). Documented at
 * https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
 *
 *   GET /api/v3/klines?symbol=BTCUSDT&interval=4h&limit=200
 *   GET /api/v3/ticker/24hr?symbol=BTCUSDT
 *   GET /api/v3/ticker/price            (all symbols; used for search)
 *
 * Errors come as {"code": -1121, "msg": "Invalid symbol."} with HTTP 400; 429/418 carry
 * Retry-After; 451 means a restricted location.
 */
export class BinanceProvider implements MarketDataProvider {
  readonly id = 'binance' as const;
  readonly label = 'Binance';
  readonly quote = 'USDT';
  private symbolList: Promise<string[]> | null = null;

  constructor(
    private readonly baseUrl: string = API_ORIGINS.binance,
    private readonly http: HttpOptions = {},
  ) {}

  async getCandles(symbol: string, interval: Interval, limit: number, signal?: AbortSignal): Promise<Candle[]> {
    const params = new URLSearchParams({ symbol: this.pair(symbol), interval, limit: String(Math.min(1000, Math.max(1, limit))) });
    const response = await this.get(`/api/v3/klines?${params}`, signal);
    return parseBinanceKlines(response.body, interval);
  }

  async getTicker(symbol: string, signal?: AbortSignal): Promise<Ticker> {
    const params = new URLSearchParams({ symbol: this.pair(symbol) });
    const response = await this.get(`/api/v3/ticker/24hr?${params}`, signal);
    return parseBinanceTicker(response.body);
  }

  async searchSymbols(query: string): Promise<SymbolMatch[]> {
    // The list is fetched once per session and shared by every search, so it isn't tied to one caller's abort signal.
    if (!this.symbolList) {
      this.symbolList = this.get('/api/v3/ticker/price').then((response) => parseBinanceSymbols(response.body, this.quote));
      this.symbolList.catch(() => {
        this.symbolList = null;
      });
    }
    return rankSymbols(await this.symbolList, query);
  }

  private pair(symbol: string): string {
    const base = symbol.toUpperCase();
    if (!isValidSymbol(base)) throw new MarketDataError('invalid-symbol', `${symbol} is not a valid ticker.`, this.id);
    return `${base}${this.quote}`;
  }

  private async get(path: string, signal?: AbortSignal): Promise<HttpResponse> {
    const now = (this.http.now ?? Date.now)();
    const response = await getJson(`${this.baseUrl}${path}`, this.id, { ...this.http, signal });
    const common = commonStatusError(response, this.id, this.label, now);
    if (common) throw common;
    if (response.status === 400 || response.status === 404) {
      const code = typeof (response.body as { code?: unknown } | undefined)?.code === 'number' ? (response.body as { code: number }).code : null;
      // -1121 Invalid symbol, -1100 illegal characters in a parameter.
      if (code === -1121 || code === -1100 || response.status === 404) {
        throw new MarketDataError('invalid-symbol', 'Binance does not list this market.', this.id, response.status);
      }
      throw new MarketDataError('unavailable', 'Binance rejected the request.', this.id, response.status);
    }
    return response;
  }
}

function malformed(detail: string): MarketDataError {
  return new MarketDataError('malformed', `Binance returned unexpected data (${detail}).`, 'binance');
}

/** Kline rows: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBase, takerQuote, ignore]. */
export function parseBinanceKlines(body: unknown, interval: Interval): Candle[] {
  if (!Array.isArray(body)) throw malformed('klines is not an array');
  const candles = body.map((row, index): Candle => {
    if (!Array.isArray(row) || row.length < 7) throw malformed(`kline ${index} has the wrong shape`);
    const openTime = row[0];
    const closeTime = row[6];
    if (!Number.isSafeInteger(openTime) || !Number.isSafeInteger(closeTime)) throw malformed(`kline ${index} has bad times`);
    const [open, high, low, close, volume] = [row[1], row[2], row[3], row[4], row[5]].map(parseDecimal);
    if (open == null || high == null || low == null || close == null || volume == null) throw malformed(`kline ${index} has a bad number`);
    // Binance's closeTime is the last millisecond of the candle; ours is exclusive.
    const end = (closeTime as number) + 1;
    if (end - (openTime as number) > INTERVAL_MS[interval]) throw malformed(`kline ${index} is longer than ${interval}`);
    return { openTime: openTime as number, closeTime: end, open, high, low, close, volume };
  });
  const problem = validateCandles(candles);
  if (problem) throw malformed(problem);
  return candles;
}

export function parseBinanceTicker(body: unknown): Ticker {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw malformed('ticker is not an object');
  const record = body as Record<string, unknown>;
  const lastPrice = parseDecimal(record.lastPrice);
  if (lastPrice === null || lastPrice <= 0) throw malformed('ticker has no last price');
  return { lastPrice, changePct24h: parseDecimal(record.priceChangePercent) };
}

/** [{symbol: "ETHBTC", price: "0.03"}] → bases quoted in `quote` that currently have a price. */
export function parseBinanceSymbols(body: unknown, quote: string): string[] {
  if (!Array.isArray(body)) throw malformed('price list is not an array');
  const bases: string[] = [];
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue;
    const { symbol, price } = item as Record<string, unknown>;
    if (typeof symbol !== 'string' || !symbol.endsWith(quote)) continue;
    const base = symbol.slice(0, -quote.length);
    const value = parseDecimal(price);
    // Delisted pairs linger with a zero price.
    if (isValidSymbol(base) && value !== null && value > 0) bases.push(base);
  }
  return bases;
}
