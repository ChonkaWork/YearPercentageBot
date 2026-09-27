import { describe, expect, it } from 'vitest';
import type { Candle, Interval, ProviderId, Ticker } from '../src/core/types';
import { MarketDataError, type MarketErrorCode } from '../src/data/errors';
import {
  cacheKey,
  deserializeMarketData,
  MarketService,
  maxStaleAge,
  pickError,
  serializeMarketData,
  type KeyValueStore,
} from '../src/data/market';
import type { MarketDataProvider, SymbolMatch } from '../src/data/provider';
import { candlesFromCloses, HOUR, walk } from './helpers';

function memoryStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key) {
      return structuredClone(data.get(key));
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

type Behaviour = 'ok' | MarketErrorCode | (() => Promise<Candle[]>);

class FakeProvider implements MarketDataProvider {
  calls = 0;
  tickerCalls = 0;
  candles: Behaviour = 'ok';
  ticker: 'ok' | MarketErrorCode = 'ok';
  search: 'ok' | MarketErrorCode = 'ok';
  retryAfterMs = 30_000;
  readonly label: string;

  constructor(
    readonly id: ProviderId,
    readonly quote: string,
  ) {
    this.label = id;
  }

  private fail(code: MarketErrorCode): never {
    throw new MarketDataError(code, `${this.id} ${code}`, this.id, code === 'rate-limited' ? 429 : null, code === 'rate-limited' ? this.retryAfterMs : null);
  }

  async getCandles(_symbol: string, interval: Interval): Promise<Candle[]> {
    this.calls++;
    if (typeof this.candles === 'function') return this.candles();
    if (this.candles !== 'ok') this.fail(this.candles);
    return candlesFromCloses(walk(80, { seed: this.id === 'binance' ? 1 : 2, drift: 0.001, noise: 0.02 }), {
      interval: interval === '1h' ? HOUR : 4 * HOUR,
    });
  }

  async getTicker(): Promise<Ticker> {
    this.tickerCalls++;
    if (this.ticker !== 'ok') this.fail(this.ticker);
    return { lastPrice: 123.45, changePct24h: -1.5 };
  }

  async searchSymbols(query: string): Promise<SymbolMatch[]> {
    if (this.search !== 'ok') this.fail(this.search);
    return [{ symbol: `${query}X`, name: null }];
  }
}

function setup() {
  let now = Date.UTC(2026, 8, 27, 12);
  const store = memoryStore();
  const binance = new FakeProvider('binance', 'USDT');
  const coinbase = new FakeProvider('coinbase', 'USD');
  const service = new MarketService({ providers: [binance, coinbase], store, now: () => now });
  return {
    store,
    binance,
    coinbase,
    service,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

describe('MarketService.load', () => {
  it('serves from cache for 60 s, then refetches; refresh bypasses the cache', async () => {
    const t = setup();
    const first = await t.service.load('BTC', '4h');
    expect(first).toMatchObject({ status: 'fresh', fromCache: false, data: { source: 'binance', quote: 'USDT', symbol: 'BTC' } });
    expect(t.binance.calls).toBe(1);

    t.advance(59_000);
    expect(await t.service.load('BTC', '4h')).toMatchObject({ status: 'fresh', fromCache: true });
    expect(t.binance.calls).toBe(1);

    expect(await t.service.load('BTC', '4h', { force: true })).toMatchObject({ status: 'fresh', fromCache: false });
    expect(t.binance.calls).toBe(2);

    t.advance(61_000);
    expect(await t.service.load('BTC', '4h')).toMatchObject({ fromCache: false });
    expect(t.binance.calls).toBe(3);
  });

  it('caches per symbol and timeframe', async () => {
    const t = setup();
    await t.service.load('BTC', '4h');
    await t.service.load('BTC', '1h');
    await t.service.load('ETH', '4h');
    expect(t.binance.calls).toBe(3);
    expect(await t.service.load('BTC', '1h')).toMatchObject({ fromCache: true, data: { interval: '1h' } });
  });

  it('falls back to Coinbase when Binance is geo-blocked, and skips Binance for a while', async () => {
    const t = setup();
    t.binance.candles = 'blocked';
    const result = await t.service.load('BTC', '4h');
    expect(result).toMatchObject({ status: 'fresh', data: { source: 'coinbase', quote: 'USD' } });
    expect(result.attempts).toEqual([{ provider: 'binance', code: 'blocked', status: null, skipped: false }]);

    const again = await t.service.load('ETH', '4h', { force: true });
    expect(again).toMatchObject({ status: 'fresh', data: { source: 'coinbase' } });
    expect(again.attempts[0]).toMatchObject({ provider: 'binance', skipped: true });
    expect(t.binance.calls).toBe(1);

    t.advance(31 * 60_000);
    t.binance.candles = 'ok';
    expect(await t.service.load('SOL', '4h')).toMatchObject({ data: { source: 'binance' } });
  });

  it.each<MarketErrorCode>(['network', 'timeout', 'unavailable', 'malformed', 'invalid-symbol'])('falls back on %s', async (code) => {
    const t = setup();
    t.binance.candles = code;
    expect(await t.service.load('BTC', '1h')).toMatchObject({ status: 'fresh', data: { source: 'coinbase' } });
  });

  it('respects Retry-After: a rate-limited provider is not asked again until it expires', async () => {
    const t = setup();
    t.binance.candles = 'rate-limited';
    t.coinbase.candles = 'rate-limited';
    t.coinbase.retryAfterMs = 10_000;
    const result = await t.service.load('BTC', '4h');
    expect(result).toMatchObject({ status: 'error', error: { code: 'rate-limited', retryAfterMs: 10_000 } });
    expect(await t.service.cooldowns()).toEqual({ binance: 30_000, coinbase: 10_000 });

    t.advance(5_000);
    const early = await t.service.load('BTC', '4h', { force: true });
    expect(early).toMatchObject({ status: 'error', error: { code: 'rate-limited', retryAfterMs: 5_000 } });
    expect(early.attempts.every((attempt) => attempt.skipped)).toBe(true);
    expect([t.binance.calls, t.coinbase.calls]).toEqual([1, 1]);

    t.advance(6_000);
    t.coinbase.candles = 'ok';
    expect(await t.service.load('BTC', '4h', { force: true })).toMatchObject({ status: 'fresh', data: { source: 'coinbase' } });
    expect([t.binance.calls, t.coinbase.calls]).toEqual([1, 2]);
  });

  it('shows older cached data as stale when every provider fails', async () => {
    const t = setup();
    await t.service.load('BTC', '4h');
    t.binance.candles = 'network';
    t.coinbase.candles = 'network';
    t.advance(5 * 60_000);
    const result = await t.service.load('BTC', '4h');
    expect(result).toMatchObject({ status: 'stale', error: { code: 'network' } });
    if (result.status === 'stale') expect(t.now() - result.data.fetchedAt).toBe(5 * 60_000);
  });

  it('does not show cached data older than two candles', async () => {
    const t = setup();
    await t.service.load('BTC', '1h');
    t.binance.candles = 'unavailable';
    t.coinbase.candles = 'unavailable';
    t.advance(maxStaleAge('1h') + 1);
    expect(await t.service.load('BTC', '1h')).toMatchObject({ status: 'error', error: { code: 'unavailable' } });
    expect(maxStaleAge('1h')).toBe(2 * HOUR);
    expect(maxStaleAge('1d')).toBe(48 * HOUR);
  });

  it('reports an invalid symbol only when no provider lists it', async () => {
    const t = setup();
    t.binance.candles = 'invalid-symbol';
    t.coinbase.candles = 'invalid-symbol';
    expect(await t.service.load('NOPE', '4h')).toMatchObject({ status: 'error', error: { code: 'invalid-symbol' } });
    t.binance.candles = 'rate-limited';
    expect(await t.service.load('NOPE', '4h')).toMatchObject({ status: 'error', error: { code: 'rate-limited' } });
  });

  it('treats an empty candle list as "not listed" rather than showing nothing', async () => {
    const t = setup();
    t.binance.candles = async () => [];
    t.coinbase.candles = 'invalid-symbol';
    expect(await t.service.load('NEW', '4h')).toMatchObject({ status: 'error', error: { code: 'invalid-symbol' } });
  });

  it('keeps the candles when only the 24h ticker fails, and remembers a ticker rate limit', async () => {
    const t = setup();
    t.binance.ticker = 'rate-limited';
    const result = await t.service.load('BTC', '4h');
    expect(result).toMatchObject({ status: 'fresh', data: { source: 'binance', ticker: null } });
    expect(await t.service.cooldowns()).toEqual({ binance: 30_000 });
    const next = await t.service.load('BTC', '4h', { force: true });
    expect(next).toMatchObject({ data: { source: 'coinbase', ticker: { lastPrice: 123.45 } } });
  });

  it('ignores a corrupted cache entry', async () => {
    const t = setup();
    await t.service.load('BTC', '4h');
    const entry = t.store.data.get(cacheKey('BTC', '4h')) as { candles: unknown[][] };
    entry.candles[3]![4] = 'NaN';
    expect(await t.service.load('BTC', '4h')).toMatchObject({ status: 'fresh', fromCache: false });
    expect(t.binance.calls).toBe(2);
  });

  it('evicts the oldest cache entries beyond 24', async () => {
    const t = setup();
    for (let i = 0; i < 26; i++) await t.service.load(`C${String(i).padStart(2, '0')}`, '4h');
    const keys = [...t.store.data.keys()].filter((key) => key.startsWith('market:v1:C'));
    expect(keys).toHaveLength(24);
    expect(keys).not.toContain(cacheKey('C00', '4h'));
    await t.service.clear();
    expect([...t.store.data.keys()]).toEqual([]);
  });

  it('lets a caller abort', async () => {
    const t = setup();
    t.binance.candles = () => Promise.reject(new DOMException('Aborted', 'AbortError'));
    await expect(t.service.load('BTC', '4h')).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.coinbase.calls).toBe(0);
  });

  it('survives a storage that throws', async () => {
    const t = setup();
    const broken: KeyValueStore = {
      get: () => Promise.reject(new Error('storage down')),
      set: () => Promise.reject(new Error('storage down')),
      remove: () => Promise.reject(new Error('storage down')),
    };
    const service = new MarketService({ providers: [t.binance], store: broken, now: t.now });
    expect(await service.load('BTC', '4h')).toMatchObject({ status: 'fresh' });
  });
});

describe('MarketService.search', () => {
  it('uses the first provider that answers', async () => {
    const t = setup();
    t.binance.search = 'blocked';
    expect(await t.service.search('li')).toEqual({ matches: [{ symbol: 'LIX', name: null }], source: 'coinbase', error: null });
  });

  it('falls back to the built-in list when nothing answers', async () => {
    const t = setup();
    t.binance.search = 'network';
    t.coinbase.search = 'network';
    const result = await t.service.search('so');
    expect(result.matches.map((m) => m.symbol)).toEqual(['SOL']);
    expect(result).toMatchObject({ source: null, error: { code: 'network' } });
  });

  it('returns nothing for an empty query', async () => {
    const t = setup();
    expect(await t.service.search(' - ')).toEqual({ matches: [], source: null, error: null });
  });
});

describe('pickError', () => {
  const error = (code: MarketErrorCode, retryAfterMs: number | null = null) => new MarketDataError(code, code, 'binance', null, retryAfterMs);

  it('prefers "try again later" errors over "not listed"', () => {
    expect(pickError([error('invalid-symbol'), error('network')]).code).toBe('network');
    expect(pickError([error('blocked'), error('invalid-symbol')]).code).toBe('blocked');
    expect(pickError([error('malformed'), error('unavailable')]).code).toBe('unavailable');
    expect(pickError([error('invalid-symbol'), error('invalid-symbol')]).code).toBe('invalid-symbol');
  });

  it('picks the shortest rate-limit wait', () => {
    expect(pickError([error('rate-limited', 30_000), error('rate-limited', 5_000)]).retryAfterMs).toBe(5_000);
  });
});

describe('cache serialization', () => {
  it('round-trips and rejects tampered data', () => {
    const now = Date.UTC(2026, 8, 27, 12);
    const candles = candlesFromCloses([1, 2, 3, 4], { interval: HOUR });
    const data = { symbol: 'BTC', quote: 'USDT', source: 'binance' as const, interval: '1h' as const, candles, ticker: { lastPrice: 4, changePct24h: null }, fetchedAt: now };
    expect(deserializeMarketData(serializeMarketData(data), now)).toEqual(data);
    const raw = serializeMarketData(data) as Record<string, unknown>;
    expect(deserializeMarketData({ ...raw, source: 'kraken' }, now)).toBeNull();
    expect(deserializeMarketData({ ...raw, fetchedAt: now + 3_600_000 }, now)).toBeNull();
    expect(deserializeMarketData({ ...raw, ticker: { lastPrice: -1, changePct24h: null } }, now)).toBeNull();
    expect(deserializeMarketData({ ...raw, candles: [] }, now)).toBeNull();
    expect(deserializeMarketData('garbage', now)).toBeNull();
  });
});
