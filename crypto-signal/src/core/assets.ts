/** Coins offered by default, in display order. */

export interface AssetInfo {
  /** Base-asset ticker, as used by Binance and Coinbase. */
  symbol: string;
  name: string;
  /** Slugs used in URLs of price sites (CoinGecko, CoinMarketCap, Coinbase, Kraken). */
  slugs: readonly string[];
  /** Other names people use in text. */
  aliases?: readonly string[];
  /** Other tickers for the same coin (Kraken calls Bitcoin XBT). */
  tickerAliases?: readonly string[];
  /** The ticker is also a common word or acronym ("ETH Zurich", "ADA compliance", "DOGE"). */
  ambiguousTicker?: boolean;
  /** The name is also a common word ("avalanche", "ripple", "Cardano" the mathematician). */
  ambiguousName?: boolean;
}

export const DEFAULT_ASSETS: readonly AssetInfo[] = Object.freeze([
  { symbol: 'BTC', name: 'Bitcoin', slugs: ['bitcoin'], tickerAliases: ['XBT'] },
  { symbol: 'ETH', name: 'Ethereum', slugs: ['ethereum'], aliases: ['Ether'], ambiguousTicker: true },
  { symbol: 'SOL', name: 'Solana', slugs: ['solana'], ambiguousTicker: true },
  { symbol: 'XRP', name: 'XRP', slugs: ['xrp', 'ripple'], aliases: ['Ripple'], ambiguousName: true },
  { symbol: 'DOGE', name: 'Dogecoin', slugs: ['dogecoin'], tickerAliases: ['XDG'], ambiguousTicker: true },
  { symbol: 'BNB', name: 'BNB', slugs: ['bnb', 'binancecoin', 'binance-coin'], aliases: ['Binance Coin'] },
  { symbol: 'ADA', name: 'Cardano', slugs: ['cardano'], ambiguousTicker: true, ambiguousName: true },
  { symbol: 'AVAX', name: 'Avalanche', slugs: ['avalanche', 'avalanche-2'], ambiguousName: true },
]);

export const DEFAULT_SYMBOL = 'BTC';

const BY_SYMBOL = new Map(DEFAULT_ASSETS.map((asset) => [asset.symbol, asset]));

export function findAsset(symbol: string): AssetInfo | undefined {
  return BY_SYMBOL.get(symbol.toUpperCase());
}

/** Display name for a symbol: "Bitcoin" for BTC, the ticker itself for coins we don't know. */
export function assetName(symbol: string): string {
  return findAsset(symbol)?.name ?? symbol.toUpperCase();
}

/** Tickers are 2–10 uppercase letters or digits (e.g. BTC, 1INCH, PEPE). */
export function isValidSymbol(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{2,10}$/.test(value);
}
