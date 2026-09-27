import { describe, expect, it, vi } from 'vitest';
import { BinanceProvider, parseBinanceKlines } from '../src/data/binance';
import { aggregateCandles, CoinbaseProvider, parseCoinbaseCandles } from '../src/data/coinbase';
import { MarketDataError } from '../src/data/errors';
import { parseDecimal, parseRetryAfter, type FetchLike } from '../src/data/http';
import { HOUR } from './helpers';

const FIXTURES = import.meta.glob<string>('./fixtures/*.json', { query: '?raw', import: 'default', eager: true });

/** Hand-written payloads following the documented API formats. */
function fixture(name: string): string {
  const text = FIXTURES[`./fixtures/${name}`];
  if (text === undefined) throw new Error(`Missing fixture ${name}`);
  return text;
}

type Reply = { status?: number; body?: string; headers?: Record<string, string> };

/** A fetch that answers from a route table and records every URL it was asked for. */
function fakeFetch(route: (url: string) => Reply | Promise<Reply>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const reply = await route(url);
    return new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers });
  };
  return { fetch, calls };
}

async function errorOf(promise: Promise<unknown>): Promise<MarketDataError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketDataError) return error;
    throw error;
  }
  throw new Error('expected a MarketDataError');
}

const NOW = Date.UTC(2026, 8, 27, 12);
const BASE = 'https://api.test';

describe('Binance provider', () => {
  const ok = (body: string): Reply => ({ status: 200, body, headers: { 'content-type': 'application/json' } });

  it('requests documented klines and normalizes candles', async () => {
    const { fetch, calls } = fakeFetch(() => ok(fixture('binance-klines-4h.json')));
    const candles = await new BinanceProvider(BASE, { fetch }).getCandles('BTC', '4h', 200);
    expect(calls).toEqual([`${BASE}/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=200`]);
    expect(candles).toHaveLength(3);
    expect(candles[2]).toEqual({
      openTime: 1790438400000,
      closeTime: 1790452800000,
      open: 63810,
      high: 64120.5,
      low: 63702.11,
      close: 64011.23,
      volume: 812.40123,
    });
    expect(candles[0]!.closeTime).toBe(candles[1]!.openTime);
  });

  it('reads last price and 24h change from ticker/24hr', async () => {
    const { fetch, calls } = fakeFetch(() => ok(fixture('binance-ticker-24hr.json')));
    expect(await new BinanceProvider(BASE, { fetch }).getTicker('btc')).toEqual({ lastPrice: 64052.41, changePct24h: 2.451 });
    expect(calls).toEqual([`${BASE}/api/v3/ticker/24hr?symbol=BTCUSDT`]);
  });

  it.each([
    [{ status: 400, body: fixture('binance-error-invalid-symbol.json') }, 'invalid-symbol'],
    [{ status: 400, body: '{"code":-1100,"msg":"Illegal characters found in parameter \'symbol\'"}' }, 'invalid-symbol'],
    [{ status: 400, body: '{"code":-1104,"msg":"Not all sent parameters were read."}' }, 'unavailable'],
    [{ status: 451, body: '{"code":0,"msg":"Service unavailable from a restricted location."}' }, 'blocked'],
    [{ status: 403, body: '<html>Forbidden</html>' }, 'blocked'],
    [{ status: 503, body: 'Service Unavailable' }, 'unavailable'],
    [{ status: 302, body: '' }, 'unavailable'],
    [{ status: 200, body: '<html>captive portal</html>' }, 'malformed'],
    [{ status: 200, body: '{"code":0}' }, 'malformed'],
  ])('maps %j to %s', async (reply, code) => {
    const { fetch } = fakeFetch(() => reply);
    const error = await errorOf(new BinanceProvider(BASE, { fetch }).getCandles('BTC', '1h', 10));
    expect(error.code).toBe(code);
    expect(error.provider).toBe('binance');
  });

  it('honours Retry-After on 429 and 418', async () => {
    const provider = (reply: Reply) => new BinanceProvider(BASE, { fetch: fakeFetch(() => reply).fetch, now: () => NOW });
    const seconds = await errorOf(provider({ status: 429, headers: { 'Retry-After': '30' } }).getTicker('BTC'));
    expect(seconds).toMatchObject({ code: 'rate-limited', status: 429, retryAfterMs: 30_000 });
    const banned = await errorOf(provider({ status: 418, headers: { 'Retry-After': '120' } }).getTicker('BTC'));
    expect(banned).toMatchObject({ code: 'rate-limited', retryAfterMs: 120_000 });
    const missing = await errorOf(provider({ status: 429 }).getTicker('BTC'));
    expect(missing.retryAfterMs).toBe(60_000);
    const date = new Date(NOW + 45_000).toUTCString();
    expect((await errorOf(provider({ status: 429, headers: { 'Retry-After': date } }).getTicker('BTC'))).retryAfterMs).toBe(45_000);
  });

  it.each([
    ['a price that is not a number', (row: unknown[]) => ((row[4] = 'abc'), row)],
    ['a NaN string', (row: unknown[]) => ((row[2] = 'NaN'), row)],
    ['an Infinity string', (row: unknown[]) => ((row[5] = 'Infinity'), row)],
    ['an exponent', (row: unknown[]) => ((row[1] = '6.4e4'), row)],
    ['a missing field', (row: unknown[]) => row.slice(0, 5)],
    ['a float time', (row: unknown[]) => ((row[0] = 1.5), row)],
    ['high below low', (row: unknown[]) => ((row[2] = '1.00'), row)],
    ['a candle longer than the interval', (row: unknown[]) => ((row[6] = (row[6] as number) + 3_600_000), row)],
    ['an object instead of a row', () => ({ open: '1' })],
  ])('rejects klines with %s', (_name, corrupt) => {
    const rows = JSON.parse(fixture('binance-klines-4h.json')) as unknown[][];
    rows[1] = corrupt(rows[1]!) as unknown[];
    expect(() => parseBinanceKlines(rows, '4h')).toThrow(MarketDataError);
  });

  it('rejects a ticker without a usable last price', async () => {
    const { fetch } = fakeFetch(() => ok('{"symbol":"BTCUSDT","lastPrice":"0.00000000"}'));
    expect((await errorOf(new BinanceProvider(BASE, { fetch }).getTicker('BTC'))).code).toBe('malformed');
  });

  it('turns a failed request into a network error and a hang into a timeout', async () => {
    const offline = new BinanceProvider(BASE, { fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    expect((await errorOf(offline.getTicker('BTC'))).code).toBe('network');
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    const slow = new BinanceProvider(BASE, { fetch: hanging, timeoutMs: 20 });
    expect((await errorOf(slow.getTicker('BTC'))).code).toBe('timeout');
  });

  it('passes a caller abort through untouched', async () => {
    const controller = new AbortController();
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    const pending = new BinanceProvider(BASE, { fetch: hanging }).getTicker('BTC', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses malformed tickers before sending anything', async () => {
    const { fetch, calls } = fakeFetch(() => ok('[]'));
    expect((await errorOf(new BinanceProvider(BASE, { fetch }).getCandles('BTC/USDT', '1h', 5))).code).toBe('invalid-symbol');
    expect(calls).toEqual([]);
  });

  it('searches USDT pairs that trade, fetching the list once', async () => {
    const { fetch, calls } = fakeFetch(() => ok(fixture('binance-ticker-price.json')));
    const provider = new BinanceProvider(BASE, { fetch });
    expect(await provider.searchSymbols('link')).toEqual([{ symbol: 'LINK', name: null }]);
    expect(await provider.searchSymbols('SOL')).toEqual([{ symbol: 'SOL', name: 'Solana' }]);
    expect((await provider.searchSymbols('bitc')).map((m) => m.symbol)).toEqual(['BTC']);
    expect((await provider.searchSymbols('1000')).map((m) => m.symbol)).toEqual(['1000SATS']);
    expect(await provider.searchSymbols('BCC')).toEqual([]); // zero price = not trading
    expect(await provider.searchSymbols('!!')).toEqual([]);
    expect(calls).toEqual([`${BASE}/api/v3/ticker/price`]);
  });

  it('retries the symbol list after a failure', async () => {
    let fail = true;
    const { fetch, calls } = fakeFetch(() => (fail ? { status: 503 } : ok(fixture('binance-ticker-price.json'))));
    const provider = new BinanceProvider(BASE, { fetch });
    await expect(provider.searchSymbols('eth')).rejects.toMatchObject({ code: 'unavailable' });
    fail = false;
    expect((await provider.searchSymbols('eth')).map((m) => m.symbol)).toEqual(['ETH']);
    expect(calls).toHaveLength(2);
  });
});

describe('Coinbase provider', () => {
  const ok = (body: string): Reply => ({ status: 200, body });

  it('reads hourly candles newest-first and returns them oldest-first', async () => {
    const { fetch, calls } = fakeFetch(() => ok(fixture('coinbase-candles-1h.json')));
    const candles = await new CoinbaseProvider(BASE, { fetch }).getCandles('BTC', '1h', 200);
    expect(calls).toEqual([`${BASE}/products/BTC-USD/candles?granularity=3600`]);
    expect(candles.map((c) => c.openTime)).toEqual([1790431200, 1790434800, 1790438400, 1790442000, 1790445600, 1790449200].map((s) => s * 1000));
    expect(candles[5]).toEqual({ openTime: 1790449200000, closeTime: 1790452800000, open: 63950.01, high: 64102.5, low: 63890.12, close: 64040.12, volume: 101.2231 });
  });

  it('builds 4h candles from hourly ones, UTC-aligned, dropping a partial first bucket', async () => {
    const { fetch, calls } = fakeFetch(() => ok(fixture('coinbase-candles-1h.json')));
    const candles = await new CoinbaseProvider(BASE, { fetch }).getCandles('BTC', '4h', 200);
    expect(calls).toEqual([`${BASE}/products/BTC-USD/candles?granularity=3600`]);
    expect(candles).toHaveLength(1);
    expect(candles[0]!.openTime).toBe(1790438400000);
    expect(candles[0]!.closeTime).toBe(1790452800000);
    expect(candles[0]).toMatchObject({ open: 63810, high: 64102.5, low: 63702.11, close: 64040.12 });
    expect(candles[0]!.volume).toBeCloseTo(405.5243, 8);
  });

  it('uses daily granularity for 1d and honours the limit', async () => {
    const { fetch, calls } = fakeFetch(() => ok(fixture('coinbase-candles-1h.json')));
    await new CoinbaseProvider(BASE, { fetch }).getCandles('ETH', '1d', 2).catch(() => undefined);
    expect(calls).toEqual([`${BASE}/products/ETH-USD/candles?granularity=86400`]);
    const hourly = await new CoinbaseProvider(BASE, { fetch: fakeFetch(() => ok(fixture('coinbase-candles-1h.json'))).fetch }).getCandles('BTC', '1h', 2);
    expect(hourly.map((c) => c.close)).toEqual([63950.01, 64040.12]);
  });

  it('computes the 24h change from /stats', async () => {
    const { fetch, calls } = fakeFetch(() => ok(fixture('coinbase-stats.json')));
    const ticker = await new CoinbaseProvider(BASE, { fetch }).getTicker('BTC');
    expect(calls).toEqual([`${BASE}/products/BTC-USD/stats`]);
    expect(ticker.lastPrice).toBe(64040.12);
    expect(ticker.changePct24h).toBeCloseTo(((64040.12 - 62510.01) / 62510.01) * 100, 10);
  });

  it('reports an unknown product as an invalid symbol', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: fixture('coinbase-error-not-found.json') }));
    expect((await errorOf(new CoinbaseProvider(BASE, { fetch }).getCandles('BNB', '4h', 10))).code).toBe('invalid-symbol');
  });

  it('rejects candles with bad numbers', () => {
    const rows = JSON.parse(fixture('coinbase-candles-1h.json')) as unknown[][];
    rows[2]![4] = 'abc';
    expect(() => parseCoinbaseCandles(rows, 3600)).toThrow(MarketDataError);
    expect(() => parseCoinbaseCandles({ message: 'x' }, 3600)).toThrow(MarketDataError);
  });

  it('searches online USD products only', async () => {
    const { fetch } = fakeFetch(() => ok(fixture('coinbase-products.json')));
    const provider = new CoinbaseProvider(BASE, { fetch });
    expect((await provider.searchSymbols('l')).map((m) => m.symbol)).toEqual(['LINK']);
    expect(await provider.searchSymbols('OLD')).toEqual([]);
    expect((await provider.searchSymbols('eth')).map((m) => m.symbol)).toEqual(['ETH']);
  });
});

describe('aggregateCandles', () => {
  it('keeps an in-progress last bucket and skips gaps', () => {
    const start = Date.UTC(2026, 0, 1);
    const hourly = [0, 1, 2, 3, 4, 6].map((h, i) => ({
      openTime: start + h * HOUR,
      closeTime: start + (h + 1) * HOUR,
      open: 10 + i,
      high: 12 + i,
      low: 9 + i,
      close: 11 + i,
      volume: 1,
    }));
    const buckets = aggregateCandles(hourly, 4 * HOUR);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toEqual({ openTime: start, closeTime: start + 4 * HOUR, open: 10, high: 15, low: 9, close: 14, volume: 4 });
    expect(buckets[1]).toEqual({ openTime: start + 4 * HOUR, closeTime: start + 8 * HOUR, open: 14, high: 17, low: 13, close: 16, volume: 2 });
  });
});

describe('http helpers', () => {
  it('parses only plain decimals', () => {
    expect(parseDecimal('64231.50000000')).toBe(64231.5);
    expect(parseDecimal('-1.25')).toBe(-1.25);
    expect(parseDecimal(12.5)).toBe(12.5);
    for (const bad of ['', ' 1', '1e5', 'NaN', 'Infinity', '0x10', '1,000', null, undefined, Number.NaN, {}]) {
      expect(parseDecimal(bad)).toBeNull();
    }
  });

  it('parses Retry-After seconds and dates, clamped to 1 s – 1 h', () => {
    expect(parseRetryAfter('5', NOW)).toBe(5000);
    expect(parseRetryAfter('0', NOW)).toBe(1000);
    expect(parseRetryAfter('999999', NOW)).toBe(3_600_000);
    expect(parseRetryAfter(new Date(NOW + 10_000).toUTCString(), NOW)).toBe(10_000);
    expect(parseRetryAfter('soon', NOW)).toBeNull();
    expect(parseRetryAfter(null, NOW)).toBeNull();
  });

  it('never sends cookies or uses the HTTP cache', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(fixture('binance-ticker-24hr.json')));
    await new BinanceProvider(BASE, { fetch }).getTicker('BTC');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' });
  });
});
