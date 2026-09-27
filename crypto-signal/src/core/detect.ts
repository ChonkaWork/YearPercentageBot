import { DEFAULT_ASSETS, isValidSymbol, type AssetInfo } from './assets';

/**
 * Finds which coin a page (or a text selection) is about. Pure: the popup passes in the tab
 * URL, the page title and the first <h1>; nothing else is read from the page.
 *
 * Order of trust: URL patterns of exchanges and price sites, then the title, then the heading.
 * Tickers that are also ordinary words or acronyms (ETH Zurich, ADA compliance, DOGE the agency,
 * "sol") only count next to crypto context words, and matches are whole words, so "Canada"
 * never yields ADA and "solution" never yields SOL.
 */

export interface PageInfo {
  url?: string | null;
  title?: string | null;
  heading?: string | null;
}

export interface Detection {
  symbol: string;
  via: 'url' | 'title' | 'heading';
}

const QUOTE_PATTERN = 'USDT|USDC|FDUSD|BUSD|TUSD|USD|EUR';
/** BASE[sep]QUOTE, e.g. BTCUSDT, BTC_USDT, BTC-USD, BTC/USDT, BINANCE:BTCUSDT. Uppercase input only. */
const PAIR_RE = new RegExp(`(?<![A-Z0-9])([A-Z0-9]{2,10}?)[-_/:]?(?:${QUOTE_PATTERN})(?![A-Z0-9])`, 'g');
const CASHTAG_RE = /(?<![\p{L}\p{N}$])\$([A-Za-z][A-Za-z0-9]{1,9})(?![\p{L}\p{N}])/gu;

/** Things that look like tickers in pairs but aren't coins we'd analyze. */
const NOT_COINS = new Set([
  'USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI', 'USDS', 'USDE', 'PYUSD',
  'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'KRW', 'INR', 'RUB', 'TRY', 'BRL',
  'UAH', 'PLN', 'MXN', 'ZAR', 'SGD', 'NZD', 'SEK', 'NOK', 'DKK', 'CZK', 'HUF', 'ARS', 'IDR',
  'PERP', 'SWAP', 'SPOT', 'TRADE', 'MARGIN', 'FUTURES', 'PRICE', 'CHART', 'TO', 'IN', 'EN',
]);

/** Exchanges, charting and price sites: here an unknown ticker in a pair is trusted. */
const CRYPTO_HOSTS = [
  'binance.com', 'binance.us', 'coinbase.com', 'kraken.com', 'bybit.com', 'okx.com', 'kucoin.com',
  'tradingview.com', 'coingecko.com', 'coinmarketcap.com', 'gate.io', 'gate.com', 'mexc.com',
  'bitget.com', 'htx.com', 'crypto.com', 'bitfinex.com', 'bitstamp.net', 'gemini.com', 'bitvavo.com',
  'dexscreener.com', 'coinglass.com', 'messari.io', 'coinpaprika.com', 'livecoinwatch.com',
];

/** Path segments followed by a coin slug: /coins/bitcoin, /currencies/solana, /price/xrp. */
const SLUG_PARENTS = new Set(['coins', 'coin', 'currencies', 'price', 'prices', 'asset', 'assets', 'crypto']);

const CONTEXT_RE =
  /(?<![\p{L}\p{N}])(crypto|cryptocurrency|cryptocurrencies|coin|coins|token|tokens|price|prices|chart|charts|usdt|usdc|usd|trading|trade|blockchain|market cap|exchange|binance|coinbase|kraken|bybit|okx|tradingview|coingecko|coinmarketcap|spot|futures|perpetual|perp|defi|staking|wallet|altcoin|altcoins|memecoin|bullish|bearish)(?![\p{L}\p{N}])/iu;

const BY_TICKER = new Map<string, AssetInfo>();
const BY_NAME = new Map<string, AssetInfo>();
for (const asset of DEFAULT_ASSETS) {
  BY_TICKER.set(asset.symbol, asset);
  for (const alias of asset.tickerAliases ?? []) BY_TICKER.set(alias, asset);
  for (const name of [asset.name, ...(asset.aliases ?? []), ...asset.slugs]) BY_NAME.set(name.toLowerCase(), asset);
}

export function detectCoin(page: PageInfo): Detection | null {
  const host = hostOf(page.url);
  const cryptoHost = host !== null && isCryptoHost(host);
  const fromUrl = page.url ? detectFromUrl(page.url) : null;
  if (fromUrl) return { symbol: fromUrl, via: 'url' };

  const title = clean(page.title);
  const heading = clean(page.heading);
  const context = cryptoHost || CONTEXT_RE.test(`${title} ${heading}`);
  const fromTitle = detectInText(title, { context, cryptoHost });
  if (fromTitle) return { symbol: fromTitle, via: 'title' };
  const fromHeading = detectInText(heading, { context, cryptoHost });
  if (fromHeading) return { symbol: fromHeading, via: 'heading' };
  return null;
}

/**
 * The user selected this text and asked for an analysis, so the rules are looser than for
 * page text: a lone ticker ("ada", "$sol", "PEPE") or a pair ("BTC/USDT") is taken at face
 * value. Longer text is scanned like a page with crypto context. Returns null when nothing
 * looks like a coin.
 */
export function detectFromSelection(text: string | null | undefined): string | null {
  const flat = clean(text).replace(/[.,!?;:)"'”’]+$/u, '').replace(/^["'“‘(]+/u, '');
  if (!flat) return null;

  const pair = new RegExp(`^\\$?([A-Z0-9]{2,10}?)\\s*[-_/: ]?\\s*(?:${QUOTE_PATTERN})$`).exec(flat.toUpperCase());
  if (pair) {
    const symbol = resolveTicker(pair[1]!, { allowUnknown: true });
    if (symbol) return symbol;
  }
  const single = /^\$?([\p{L}\p{N}][\p{L}\p{N} -]{0,20})$/u.exec(flat);
  if (single) {
    const token = single[1]!.trim();
    const named = BY_NAME.get(token.toLowerCase());
    if (named) return named.symbol;
    if (!/\s/.test(token)) {
      const symbol = resolveTicker(token.toUpperCase(), { allowUnknown: true });
      if (symbol) return symbol;
    }
  }
  return detectInText(flat, { context: true, cryptoHost: false });
}

// --- URL --------------------------------------------------------------------------------

export function detectFromUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const cryptoHost = isCryptoHost(url.hostname);
  const path = safeDecode(url.pathname);
  const query = safeDecode(url.search);

  for (const match of `${path} ${query}`.toUpperCase().matchAll(PAIR_RE)) {
    const symbol = resolveTicker(match[1]!, { allowUnknown: cryptoHost });
    if (symbol) return symbol;
  }

  const segments = path.toLowerCase().split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    if (!SLUG_PARENTS.has(segments[i]!)) continue;
    const slug = segments[i + 1]!;
    const asset = BY_NAME.get(slug) ?? BY_TICKER.get(slug.toUpperCase());
    if (asset) return asset.symbol;
  }
  return null;
}

// --- Text -------------------------------------------------------------------------------

interface TextOptions {
  /** Crypto words appear nearby, so ambiguous tickers and names count. */
  context: boolean;
  /** On exchanges and price sites unknown tickers in pairs count too. */
  cryptoHost: boolean;
}

interface Candidate {
  symbol: string;
  index: number;
}

function detectInText(text: string, options: TextOptions): string | null {
  if (!text) return null;
  const candidates: Candidate[] = [];

  for (const match of text.matchAll(PAIR_RE)) {
    const symbol = resolveTicker(match[1]!, { allowUnknown: options.cryptoHost });
    if (symbol) candidates.push({ symbol, index: match.index });
  }
  for (const match of text.matchAll(CASHTAG_RE)) {
    const symbol = resolveTicker(match[1]!.toUpperCase(), { allowUnknown: options.cryptoHost });
    if (symbol) candidates.push({ symbol, index: match.index });
  }
  for (const asset of DEFAULT_ASSETS) {
    if (!asset.ambiguousTicker || options.context) {
      for (const ticker of [asset.symbol, ...(asset.tickerAliases ?? [])]) {
        const index = wordIndex(text, ticker, false);
        if (index >= 0) candidates.push({ symbol: asset.symbol, index });
      }
    }
    if (!asset.ambiguousName || options.context) {
      for (const name of [asset.name, ...(asset.aliases ?? [])]) {
        const index = wordIndex(text, name, true);
        if (index >= 0) candidates.push({ symbol: asset.symbol, index });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]!.symbol;
}

/** Position of `word` as a whole word (not inside another word), or −1. */
function wordIndex(text: string, word: string, ignoreCase: boolean): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, ignoreCase ? 'iu' : 'u');
  return re.exec(text)?.index ?? -1;
}

// --- Helpers ----------------------------------------------------------------------------

/** Maps a ticker-like token to a symbol: known tickers, aliases and names; unknown ones only when allowed. */
function resolveTicker(token: string, options: { allowUnknown: boolean }): string | null {
  const upper = token.toUpperCase();
  const known = BY_TICKER.get(upper) ?? BY_NAME.get(upper.toLowerCase());
  if (known) return known.symbol;
  if (!options.allowUnknown || NOT_COINS.has(upper) || !isValidSymbol(upper) || !/[A-Z]/.test(upper)) return null;
  return upper;
}

function hostOf(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

function isCryptoHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return CRYPTO_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}
