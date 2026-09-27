// Generates the recorded-style API payloads in e2e/fixtures/api/ that the e2e fixture server
// replays in place of Binance and Coinbase (their real APIs are not reachable from CI/sandbox).
// The payloads follow the documented response formats field by field; the prices are a seeded
// random walk, rescaled to realistic levels, so every run produces identical files.
// test/fixtures.test.ts checks that each file yields the signal state the e2e suite expects.
//
//   node e2e/fixtures/make-fixtures.mjs

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), 'api');
const HOUR = 3_600_000;
const DURATION = { '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR };
/** Open time of the newest candle in each series ("recorded" on 2026-09-20; every candle is closed). */
const LAST_OPEN = { '1h': Date.UTC(2026, 8, 20, 19), '4h': Date.UTC(2026, 8, 20, 16), '1d': Date.UTC(2026, 8, 19) };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same walk as test/helpers.ts: close = previous × (1 + drift + noise·(r − 0.5)). */
function walk(length, { seed, drift, noise }) {
  const random = rng(seed);
  const closes = [100];
  for (let i = 1; i < length; i++) closes.push(closes[i - 1] * (1 + drift + noise * (random() - 0.5)));
  return closes;
}

/** OHLCV candles ending at `lastOpen`, rescaled so the newest close is `lastPrice`. */
function series({ seed, drift, noise = 0.025, count = 200, interval, lastPrice, decimals, baseVolume, lastVolume = 2.4 }) {
  const raw = walk(count, { seed, drift, noise });
  const scale = lastPrice / raw[raw.length - 1];
  const round = (value) => Number(value.toFixed(decimals));
  const closes = raw.map((value) => round(value * scale));
  const volumeRandom = rng(seed * 7919);
  const duration = DURATION[interval];
  const first = LAST_OPEN[interval] - (count - 1) * duration;
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    const factor = i === count - 1 ? lastVolume : 0.85 + 0.3 * volumeRandom();
    return {
      openTime: first + i * duration,
      open,
      high: round(Math.max(open, close) * 1.002),
      low: round(Math.min(open, close) * 0.998),
      close,
      volume: Number((baseVolume * factor).toFixed(4)),
    };
  });
}

const fixed = (value) => value.toFixed(8);

function binanceKlines(candles, interval) {
  return candles.map((c, i) => [
    c.openTime,
    fixed(c.open),
    fixed(c.high),
    fixed(c.low),
    fixed(c.close),
    fixed(c.volume),
    c.openTime + DURATION[interval] - 1,
    fixed(c.volume * c.close),
    1000 + ((i * 7919) % 50_000),
    fixed(c.volume * 0.52),
    fixed(c.volume * 0.52 * c.close),
    '0',
  ]);
}

function binanceTicker(symbol, fourHour) {
  const window = fourHour.slice(-6);
  const open = window[0].open;
  const last = window[window.length - 1].close;
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const volume = window.reduce((sum, c) => sum + c.volume, 0);
  const closeTime = window[window.length - 1].openTime + DURATION['4h'] - 1;
  return {
    symbol,
    priceChange: fixed(last - open),
    priceChangePercent: (((last - open) / open) * 100).toFixed(3),
    weightedAvgPrice: fixed((open + last) / 2),
    prevClosePrice: fixed(open),
    lastPrice: fixed(last),
    lastQty: '0.01200000',
    bidPrice: fixed(last),
    bidQty: '1.50000000',
    askPrice: fixed(last),
    askQty: '0.80000000',
    openPrice: fixed(open),
    highPrice: fixed(high),
    lowPrice: fixed(low),
    volume: fixed(volume),
    quoteVolume: fixed(volume * last),
    openTime: closeTime + 1 - 24 * HOUR,
    closeTime,
    firstId: 4_100_000_000,
    lastId: 4_100_812_345,
    count: 812_346,
  };
}

/** Coinbase: [time (s), low, high, open, close, volume], newest first. */
function coinbaseCandles(candles) {
  return [...candles].reverse().map((c) => [c.openTime / 1000, c.low, c.high, c.open, c.close, c.volume]);
}

function coinbaseStats(hourly) {
  const day = hourly.slice(-24);
  const last = day[day.length - 1].close;
  return {
    open: String(day[0].open),
    high: String(Math.max(...day.map((c) => c.high))),
    low: String(Math.min(...day.map((c) => c.low))),
    last: String(last),
    volume: day.reduce((sum, c) => sum + c.volume, 0).toFixed(8),
    volume_30day: (day.reduce((sum, c) => sum + c.volume, 0) * 30).toFixed(8),
  };
}

function product(base, quote, status = 'online') {
  return {
    id: `${base}-${quote}`,
    base_currency: base,
    quote_currency: quote,
    quote_increment: '0.01',
    base_increment: '0.00000001',
    display_name: `${base}-${quote}`,
    min_market_funds: '1',
    margin_enabled: false,
    post_only: false,
    limit_only: false,
    cancel_only: false,
    status,
    status_message: '',
    trading_disabled: status !== 'online',
    fx_stablecoin: false,
    max_slippage_percentage: '0.02000000',
    auction_mode: false,
    high_bid_limit_percentage: '',
  };
}

// --- Binance -----------------------------------------------------------------------------

// seed/drift pairs chosen from the engine's behaviour (see test/fixtures.test.ts for the result of each).
const BINANCE = [
  { symbol: 'BTC', interval: '4h', seed: 1, drift: 0.002, lastPrice: 64231.5, decimals: 2, baseVolume: 820 }, // strong bullish
  { symbol: 'BTC', interval: '1h', seed: 22, drift: 0.002, lastPrice: 64231.5, decimals: 2, baseVolume: 210 }, // bullish
  { symbol: 'BTC', interval: '1d', seed: 3, drift: 0, lastPrice: 64231.5, decimals: 2, baseVolume: 19_500 }, // neutral
  { symbol: 'ETH', interval: '4h', seed: 19, drift: -0.002, lastPrice: 3120.55, decimals: 2, baseVolume: 9_400 }, // bearish
  { symbol: 'SOL', interval: '4h', seed: 3, drift: 0, lastPrice: 142.37, decimals: 2, baseVolume: 61_000 }, // neutral
  { symbol: 'XRP', interval: '4h', seed: 14, drift: 0, lastPrice: 0.5234, decimals: 4, baseVolume: 9_100_000 }, // neutral
  { symbol: 'DOGE', interval: '4h', seed: 21, drift: -0.002, lastPrice: 0.12345, decimals: 5, baseVolume: 48_000_000 }, // strong bearish
  { symbol: 'BNB', interval: '4h', seed: 6, drift: 0.002, lastPrice: 584.2, decimals: 2, baseVolume: 5_200 }, // strong bullish
  { symbol: 'ADA', interval: '4h', seed: 26, drift: -0.002, lastPrice: 0.4512, decimals: 4, baseVolume: 7_300_000 }, // bearish
  { symbol: 'AVAX', interval: '4h', seed: 13, drift: 0.002, lastPrice: 27.84, decimals: 2, baseVolume: 180_000 }, // bullish
  { symbol: 'LINK', interval: '4h', seed: 11, drift: 0.002, lastPrice: 14.213, decimals: 3, baseVolume: 240_000 }, // strong bullish
  { symbol: 'FRESH', interval: '4h', seed: 5, drift: 0.001, count: 40, lastPrice: 0.8123, decimals: 4, baseVolume: 1_200_000 }, // too new
];

// --- Coinbase (fallback) -----------------------------------------------------------------

const COINBASE = [
  { symbol: 'BTC', seed: 41, drift: 0.0007, noise: 0.012, lastPrice: 64190.12, decimals: 2, baseVolume: 180 },
  { symbol: 'ETH', seed: 44, drift: -0.0007, noise: 0.012, lastPrice: 3118.4, decimals: 2, baseVolume: 2_600 },
];

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'binance'), { recursive: true });
await mkdir(join(out, 'coinbase'), { recursive: true });
const write = (path, data) => writeFile(join(out, path), `${JSON.stringify(data)}\n`);

const fourHour = new Map();
for (const spec of BINANCE) {
  const candles = series(spec);
  if (spec.interval === '4h') fourHour.set(spec.symbol, candles);
  await write(`binance/klines-${spec.symbol}USDT-${spec.interval}.json`, binanceKlines(candles, spec.interval));
}
for (const [symbol, candles] of fourHour) await write(`binance/ticker-${symbol}USDT.json`, binanceTicker(`${symbol}USDT`, candles));

const listed = [...fourHour.keys()];
const priceList = [
  ...listed.map((symbol) => ({ symbol: `${symbol}USDT`, price: fixed(fourHour.get(symbol).at(-1).close) })),
  { symbol: 'ETHBTC', price: '0.04859000' },
  { symbol: 'LINKBTC', price: '0.00022130' },
  { symbol: 'LTCUSDT', price: '66.41000000' },
  { symbol: 'LDOUSDT', price: '1.18200000' },
  { symbol: 'PEPEUSDT', price: '0.00001234' },
  { symbol: 'SOLBNB', price: '0.24370000' },
  { symbol: 'USDCUSDT', price: '1.00010000' },
  { symbol: 'LUNCUSDT', price: '0.00000000' },
];
await write('binance/ticker-price.json', priceList);

for (const spec of COINBASE) {
  const hourly = series({ ...spec, interval: '1h', count: 300 });
  const daily = series({ ...spec, interval: '1d', count: 300, drift: spec.drift * 6, noise: 0.03, seed: spec.seed + 1 });
  await write(`coinbase/candles-${spec.symbol}-USD-3600.json`, coinbaseCandles(hourly));
  await write(`coinbase/candles-${spec.symbol}-USD-86400.json`, coinbaseCandles(daily));
  await write(`coinbase/stats-${spec.symbol}-USD.json`, coinbaseStats(hourly));
}
await write('coinbase/products.json', [
  ...['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC'].map((base) => product(base, 'USD')),
  product('ETH', 'BTC'),
  product('OLD', 'USD', 'delisted'),
]);

console.log(`Wrote fixtures to ${out}`);
