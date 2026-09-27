import { describe, expect, it, vi } from 'vitest';
import { MemoryBackend, TtlCache } from '../src/data/cache';
import { historyUrl, parsePriceHistory } from '../src/data/clob';
import { DataError, describeError, type DataErrorCode } from '../src/data/errors';
import { firstOfList, parentEventSlug, parseEncodedArray, parseGammaEvent, parseGammaMarket, parseSearchResponse } from '../src/data/gamma';
import { getJson, type FetchLike } from '../src/data/http';
import { eventPayload, readFixture } from './helpers';

async function code(promise: Promise<unknown>): Promise<DataErrorCode | 'none'> {
  try {
    await promise;
    return 'none';
  } catch (error) {
    if (error instanceof DataError) return error.code;
    throw error;
  }
}

function codeOf(fn: () => unknown): DataErrorCode | 'none' {
  try {
    fn();
    return 'none';
  } catch (error) {
    if (error instanceof DataError) return error.code;
    throw error;
  }
}

const rawMarket = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  slug: 'will-it-rain',
  question: 'Will it rain?',
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.62", "0.38"]',
  clobTokenIds: '["111", "222"]',
  volume24hr: 1000,
  volume1wk: 7000,
  liquidity: '12345.5',
  oneDayPriceChange: 0.02,
  endDate: '2026-12-31T12:00:00Z',
  ...overrides,
});

describe('Gamma parsing', () => {
  it('reads JSON-encoded arrays, numeric strings and optional fields', () => {
    const market = parseGammaMarket(rawMarket());
    expect(market).toMatchObject({
      id: '42',
      probability: 0.62,
      change24h: 0.02,
      change7d: null,
      volume24h: 1000,
      volume7d: 7000,
      liquidity: 12345.5,
      endDate: Date.parse('2026-12-31T12:00:00Z'),
      closed: false,
      label: null,
    });
    expect(market.outcomes).toEqual([
      { name: 'Yes', probability: 0.62, tokenId: '111' },
      { name: 'No', probability: 0.38, tokenId: '222' },
    ]);
  });

  it('accepts real arrays and prefers liquidityNum/volumeNum', () => {
    const market = parseGammaMarket(rawMarket({ outcomes: ['Lakers', 'Celtics'], outcomePrices: [0.55, 0.45], liquidityNum: 99, volumeNum: 5 }));
    expect(market.outcomes.map((outcome) => outcome.name)).toEqual(['Lakers', 'Celtics']);
    expect(market.liquidity).toBe(99);
    expect(market.volumeTotal).toBe(5);
  });

  it('keeps a market readable but unpriced when prices are missing, mismatched or invalid', () => {
    expect(parseGammaMarket(rawMarket({ outcomePrices: undefined })).probability).toBeNull();
    expect(parseGammaMarket(rawMarket({ outcomePrices: '["0.5"]' })).probability).toBeNull();
    expect(parseGammaMarket(rawMarket({ outcomePrices: '["62", "38"]' })).probability).toBeNull();
    expect(parseGammaMarket(rawMarket({ outcomePrices: 'garbage' })).probability).toBeNull();
    expect(parseGammaMarket(rawMarket({ clobTokenIds: '["1"]' })).outcomes[0]!.tokenId).toBeNull();
    expect(parseGammaMarket(rawMarket({ volume24hr: 'lots', liquidity: -5 }))).toMatchObject({ volume24h: null, liquidity: null });
    expect(parseGammaMarket(rawMarket({ oneDayPriceChange: 4 })).change24h).toBeNull();
  });

  it('rejects malformed market objects', () => {
    expect(codeOf(() => parseGammaMarket(null))).toBe('INVALID_RESPONSE');
    expect(codeOf(() => parseGammaMarket(rawMarket({ question: '' })))).toBe('INVALID_RESPONSE');
    expect(codeOf(() => parseGammaMarket(rawMarket({ slug: '../etc/passwd' })))).toBe('INVALID_RESPONSE');
    expect(codeOf(() => parseGammaMarket(rawMarket({ outcomes: 'Yes, No' })))).toBe('INVALID_RESPONSE');
    expect(codeOf(() => parseGammaMarket(rawMarket({ outcomes: '["Yes"]' })))).toBe('INVALID_RESPONSE');
  });

  it('marks closed, archived and inactive markets closed', () => {
    expect(parseGammaMarket(rawMarket({ closed: true })).closed).toBe(true);
    expect(parseGammaMarket(rawMarket({ archived: true })).closed).toBe(true);
    expect(parseGammaMarket(rawMarket({ active: false })).closed).toBe(true);
  });

  it('parses events, separating closed and unreadable markets', () => {
    const { event, closed } = parseGammaEvent(eventPayload('atlantic-named-storms-2026')[0]);
    expect(event).toMatchObject({ slug: 'atlantic-named-storms-2026', mutuallyExclusive: true, hiddenMarkets: 1 });
    expect(event.markets).toHaveLength(5);
    expect(closed).toHaveLength(1);
    const withBroken = structuredClone(eventPayload('fed-decision-december-2026')[0]) as { markets: unknown[] };
    withBroken.markets.push({ id: 'x', slug: 'broken', question: 'Broken?', outcomes: 'nope' });
    expect(parseGammaEvent(withBroken).event.hiddenMarkets).toBe(1);
  });

  it('rejects malformed events and all-unreadable events', () => {
    expect(codeOf(() => parseGammaEvent(eventPayload('malformed-market')[0]))).toBe('INVALID_RESPONSE');
    expect(codeOf(() => parseGammaEvent({ id: 1, slug: 'x', title: 'X' }))).toBe('INVALID_RESPONSE');
    expect(codeOf(() => parseGammaEvent('[]'))).toBe('INVALID_RESPONSE');
  });

  it('list endpoints: empty is not found, non-list is invalid', () => {
    expect(codeOf(() => firstOfList([]))).toBe('NOT_FOUND');
    expect(codeOf(() => firstOfList({ markets: [] }))).toBe('INVALID_RESPONSE');
    expect(firstOfList([1, 2])).toBe(1);
  });

  it('parent event slug and encoded arrays', () => {
    const [market] = readFixture('gamma/markets/will-global-ev-sales-exceed-20-million-in-2026.json') as unknown[];
    expect(parentEventSlug(market)).toBe('ev-sales-20m-2026');
    expect(parentEventSlug({})).toBeNull();
    expect(parseEncodedArray('[1,2]')).toEqual([1, 2]);
    expect(parseEncodedArray('{"a":1}')).toBeNull();
  });

  it('search results: open events only, leader for multi-market events', () => {
    const events = ['atlantic-named-storms-2026', 'ev-sales-20m-2026', 'winter-olympics-2026-opening-date', 'malformed-market'].map((slug) => eventPayload(slug)[0]);
    const results = parseSearchResponse({ events, tags: [], profiles: [] });
    expect(results.map((result) => result.eventSlug)).toEqual(['atlantic-named-storms-2026', 'ev-sales-20m-2026', 'malformed-market']);
    expect(results[0]).toMatchObject({ marketCount: 5, probability: null, leader: { label: '17–19', probability: 0.41 } });
    expect(results[1]).toMatchObject({ marketCount: 1, probability: 0.624, outcomeName: 'Yes', leader: null });
    expect(results[2]).toMatchObject({ marketCount: 0, probability: null, leader: null });
    expect(parseSearchResponse({ tags: [] })).toEqual([]);
    expect(codeOf(() => parseSearchResponse({ events: 'x' }))).toBe('INVALID_RESPONSE');
    expect(codeOf(() => parseSearchResponse(null))).toBe('INVALID_RESPONSE');
  });
});

describe('CLOB price history', () => {
  it('parses {history:[{t,p}]} with seconds, strings and junk', () => {
    const series = parsePriceHistory({
      history: [
        { t: 1_790_000_000, p: 0.5 },
        { t: '1789996400', p: '0.49' },
        { t: 1_790_003_600_000, p: 0.51 },
        { t: 1_790_007_200, p: 1.4 },
        { t: null, p: 0.5 },
        'junk',
      ],
    });
    expect(series).toEqual([
      { t: 1_789_996_400_000, p: 0.49 },
      { t: 1_790_000_000_000, p: 0.5 },
      { t: 1_790_003_600_000, p: 0.51 },
    ]);
  });

  it('empty history is MISSING_HISTORY, malformed is INVALID_RESPONSE', () => {
    expect(codeOf(() => parsePriceHistory({ history: [] }))).toBe('MISSING_HISTORY');
    expect(codeOf(() => parsePriceHistory({ history: [{ t: 1, p: 0.5 }] }))).toBe('MISSING_HISTORY');
    expect(codeOf(() => parsePriceHistory({ history: [{ t: 'x', p: 'y' }] }))).toBe('INVALID_RESPONSE');
    expect(codeOf(() => parsePriceHistory({ prices: [] }))).toBe('INVALID_RESPONSE');
    expect(codeOf(() => parsePriceHistory([]))).toBe('INVALID_RESPONSE');
  });

  it('builds the documented query', () => {
    expect(historyUrl('https://clob.polymarket.com', '123', '7d')).toBe('https://clob.polymarket.com/prices-history?market=123&interval=1w&fidelity=60');
    expect(historyUrl('https://clob.polymarket.com', '123', '24h')).toContain('interval=1d&fidelity=10');
    expect(historyUrl('https://clob.polymarket.com', '123', '30d')).toContain('interval=1m&fidelity=360');
  });
});

describe('HTTP error classification', () => {
  const respond = (status: number, body = '[]', headers: Record<string, string> = {}): FetchLike => async () => new Response(body, { status, headers });

  it('maps statuses and bodies to error codes', async () => {
    expect(await getJson('u', { fetch: respond(200, '{"ok":true}') })).toEqual({ ok: true });
    expect(await code(getJson('u', { fetch: respond(404) }))).toBe('NOT_FOUND');
    expect(await code(getJson('u', { fetch: respond(503) }))).toBe('UNAVAILABLE');
    expect(await code(getJson('u', { fetch: respond(400) }))).toBe('UNAVAILABLE');
    expect(await code(getJson('u', { fetch: respond(200, '<html>oops') }))).toBe('INVALID_RESPONSE');
    expect(await code(getJson('u', { fetch: async () => Promise.reject(new TypeError('Failed to fetch')) }))).toBe('NETWORK');
  });

  it('reads Retry-After on 429', async () => {
    try {
      await getJson('u', { fetch: respond(429, '', { 'retry-after': '30' }) });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DataError);
      expect((error as DataError).details).toEqual({ status: 429, retryAfterSeconds: 30 });
      expect(describeError(error).message).toBe('Polymarket is limiting requests right now. Try again in 30 s.');
    }
  });

  it('times out, and rethrows a caller abort as is', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    expect(await code(getJson('u', { fetch: hang, timeoutMs: 20 }))).toBe('TIMEOUT');
    const controller = new AbortController();
    const pending = getJson('u', { fetch: hang, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('every error code has a user message', () => {
    for (const errorCode of ['NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'NOT_FOUND', 'UNAVAILABLE', 'INVALID_RESPONSE', 'UNSUPPORTED_MARKET', 'MISSING_HISTORY'] as const) {
      const description = describeError(new DataError(errorCode, 'Closed market.'));
      expect(description.title.length).toBeGreaterThan(5);
      expect(description.message.length).toBeGreaterThan(5);
    }
    expect(describeError(new Error('x')).title).toBe('Something went wrong');
  });
});

describe('TTL cache', () => {
  function setup(ttlMs = 60_000, maxStaleMs = 3_600_000) {
    let now = 1_000_000;
    const cache = new TtlCache(new MemoryBackend(), { ttlMs, maxStaleMs, now: () => now });
    return { cache, advance: (ms: number) => (now += ms) };
  }

  it('serves fresh entries without loading, refetches after the TTL or on force', async () => {
    const { cache, advance } = setup();
    const load = vi.fn(async () => 'v1');
    expect(await cache.get('k', load)).toMatchObject({ data: 'v1', fromCache: false, stale: false, fetchedAt: 1_000_000 });
    advance(59_000);
    expect(await cache.get('k', load)).toMatchObject({ data: 'v1', fromCache: true, stale: false });
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get('k', load, { force: true });
    expect(load).toHaveBeenCalledTimes(2);
    advance(61_000);
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('serves stale data with the error when a refresh fails', async () => {
    const { cache, advance } = setup();
    await cache.get('k', async () => 'old');
    advance(5 * 60_000);
    const failure = new DataError('UNAVAILABLE', 'HTTP 503', { status: 503 });
    const result = await cache.get('k', async () => Promise.reject(failure));
    expect(result).toMatchObject({ data: 'old', stale: true, fromCache: true, fetchedAt: 1_000_000 });
    expect(result.error).toBe(failure);
  });

  it('never serves stale data for a market that is gone, or data older than maxStale', async () => {
    const { cache, advance } = setup(60_000, 10 * 60_000);
    await cache.get('gone', async () => 'old');
    await cache.get('old', async () => 'old');
    advance(2 * 60_000);
    expect(await code(cache.get('gone', async () => Promise.reject(new DataError('NOT_FOUND', 'x'))))).toBe('NOT_FOUND');
    expect(await code(cache.get('gone', async () => Promise.reject(new DataError('NETWORK', 'x'))))).toBe('NETWORK');
    advance(20 * 60_000);
    expect(await code(cache.get('old', async () => Promise.reject(new DataError('NETWORK', 'x'))))).toBe('NETWORK');
  });

  it('shares one request between concurrent callers, and survives a broken backend', async () => {
    const { cache } = setup();
    let resolve!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((done) => (resolve = done)));
    const both = Promise.all([cache.get('k', load), cache.get('k', load)]);
    await Promise.resolve();
    await Promise.resolve();
    resolve('v');
    expect((await both).map((result) => result.data)).toEqual(['v', 'v']);
    expect(load).toHaveBeenCalledTimes(1);

    const broken = new TtlCache(
      { get: async () => Promise.reject(new Error('x')), set: async () => Promise.reject(new Error('quota')), delete: async () => undefined },
      { ttlMs: 1000, maxStaleMs: 1000 },
    );
    expect((await broken.get('k', async () => 5)).data).toBe(5);
  });
});
