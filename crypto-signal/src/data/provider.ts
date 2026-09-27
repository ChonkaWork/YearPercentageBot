import { DEFAULT_ASSETS } from '../core/assets';
import type { Candle, Interval, ProviderId, Ticker } from '../core/types';

/** A public market-data source. Symbols are base-asset tickers ("BTC"); each provider picks its quote. */
export interface MarketDataProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Quote currency this provider prices in (USDT on Binance, USD on Coinbase). */
  readonly quote: string;
  /** Oldest first, at most `limit`, the last one may still be in progress. */
  getCandles(symbol: string, interval: Interval, limit: number, signal?: AbortSignal): Promise<Candle[]>;
  getTicker(symbol: string, signal?: AbortSignal): Promise<Ticker>;
  /** Tradable symbols matching a ticker or name fragment, best first. */
  searchSymbols(query: string): Promise<SymbolMatch[]>;
}

export interface SymbolMatch {
  symbol: string;
  name: string | null;
}

export const SEARCH_RESULT_LIMIT = 20;

/** Uppercase letters and digits only, at most 12 characters. */
export function normalizeQuery(query: string): string {
  return query.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

/**
 * Ranks tradable symbols against a query: exact ticker, then tickers starting with it
 * (shortest first), then coins whose name matches, then tickers containing it.
 */
export function rankSymbols(symbols: Iterable<string>, query: string, limit = SEARCH_RESULT_LIMIT): SymbolMatch[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const available = new Set(symbols);
  const exact: string[] = [];
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const symbol of available) {
    if (symbol === q) exact.push(symbol);
    else if (symbol.startsWith(q)) prefix.push(symbol);
    else if (q.length >= 2 && symbol.includes(q)) contains.push(symbol);
  }
  const byName = DEFAULT_ASSETS.filter(
    (asset) => available.has(asset.symbol) && [asset.name, ...(asset.aliases ?? [])].some((name) => normalizeQuery(name).startsWith(q)),
  ).map((asset) => asset.symbol);
  const sort = (list: string[]) => list.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const ordered = [...exact, ...sort(prefix), ...byName, ...sort(contains)];
  const seen = new Set<string>();
  const matches: SymbolMatch[] = [];
  for (const symbol of ordered) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    matches.push({ symbol, name: DEFAULT_ASSETS.find((asset) => asset.symbol === symbol)?.name ?? null });
    if (matches.length >= limit) break;
  }
  return matches;
}
