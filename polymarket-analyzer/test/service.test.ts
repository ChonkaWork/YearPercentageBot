import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryBackend, TtlCache } from '../src/data/cache';
import { DataError } from '../src/data/errors';
import type { FetchLike } from '../src/data/http';
import { PolymarketService } from '../src/data/polymarketService';
import { marketOf } from './helpers';

const root = join(import.meta.dirname, '..');
const GAMMA = 'https://gamma.test';
const CLOB = 'https://clob.test';

/** A fake fetch that answers like the Gamma/CLOB APIs from the fixture files. */
function fixtureFetch(overrides: Record<string, () => Response> = {}): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const tokenToSlug = new Map<string, string>();
  const fetch: FetchLike = async (input) => {
    calls.push(input);
    const url = new URL(input);
    for (const [pattern, respond] of Object.entries(overrides)) if (input.includes(pattern)) return respond();
    const slug = url.searchParams.get('slug') ?? '';
    const file = (path: string) => (existsSync(join(root, 'fixtures', path)) ? readFileSync(join(root, 'fixtures', path), 'utf8') : null);
    if (url.pathname === '/events') return new Response(file(`gamma/events/${slug}.json`) ?? '[]');
    if (url.pathname === '/markets') return new Response(file(`gamma/markets/${slug}.json`) ?? '[]');
    if (url.pathname === '/prices-history') {
      const marketSlug = tokenToSlug.get(url.searchParams.get('market') ?? '');
      const range = { '1d': '24h', '1w': '7d', '1m': '30d' }[url.searchParams.get('interval') ?? ''];
      return new Response((marketSlug && file(`clob/${marketSlug}.${range}.json`)) || '{"history":[]}');
    }
    return new Response('not found', { status: 404 });
  };
  // Map token ids to fixture slugs, like the e2e server does.
  for (const name of ['ev-sales-20m-2026', 'atlantic-named-storms-2026', 'fed-decision-december-2026', 'private-lunar-landing-2026']) {
    const [event] = JSON.parse(readFileSync(join(root, 'fixtures/gamma/events', `${name}.json`), 'utf8')) as { markets: { slug: string; clobTokenIds: string }[] }[];
    for (const market of event!.markets) tokenToSlug.set(JSON.parse(market.clobTokenIds)[0], market.slug);
  }
  return { fetch, calls };
}

function service(overrides?: Record<string, () => Response>) {
  const { fetch, calls } = fixtureFetch(overrides);
  const cache = new TtlCache(new MemoryBackend(), { ttlMs: 60_000, maxStaleMs: 3_600_000 });
  return { service: new PolymarketService({ gammaBase: GAMMA, clobBase: CLOB, fetch, cache }), calls };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'none';
  } catch (error) {
    return error instanceof DataError ? error.code : String(error);
  }
}

describe('PolymarketService', () => {
  it('event page with one market → binary context', async () => {
    const { service: api, calls } = service();
    const result = await api.getCurrentMarket({ eventSlug: 'ev-sales-20m-2026', marketSlug: null });
    expect(result.data.kind).toBe('binary');
    expect(result.data.market.question).toBe('Will global EV sales exceed 20 million in 2026?');
    expect(calls).toEqual([`${GAMMA}/events?slug=ev-sales-20m-2026`]);
  });

  it('multi-market event → multi context focused on the leader', async () => {
    const { service: api } = service();
    const { data } = await api.getCurrentMarket({ eventSlug: 'atlantic-named-storms-2026', marketSlug: null });
    expect(data.kind).toBe('multi');
    expect(data.market.label).toBe('17–19');
    expect(data.event?.markets).toHaveLength(5);
  });

  it('event + market slug → that market, with its event for related markets', async () => {
    const { service: api } = service();
    const { data } = await api.getCurrentMarket({ eventSlug: 'fed-decision-december-2026', marketSlug: 'fed-no-change-december-2026' });
    expect(data.kind).toBe('binary');
    expect(data.market.label).toBe('No change');
    expect(data.event?.markets).toHaveLength(4);
  });

  it('/market/<slug> → market lookup plus its parent event', async () => {
    const { service: api, calls } = service();
    const { data } = await api.getCurrentMarket({ eventSlug: null, marketSlug: 'will-global-ev-sales-exceed-20-million-in-2026' });
    expect(data.market.probability).toBe(0.624);
    expect(data.event?.slug).toBe('ev-sales-20m-2026');
    expect(calls).toEqual([`${GAMMA}/markets?slug=will-global-ev-sales-exceed-20-million-in-2026`, `${GAMMA}/events?slug=ev-sales-20m-2026`]);
  });

  it('volume, liquidity and outcomes helpers read the same cached market', async () => {
    const { service: api, calls } = service();
    const ref = { eventSlug: 'ev-sales-20m-2026', marketSlug: null };
    expect(await api.getMarketVolume(ref)).toEqual({ volume24h: 245120.44, volume7d: 1432210.9, volumeTotal: 8812345.12 });
    expect(await api.getMarketLiquidity(ref)).toBe(1184233.5521);
    expect((await api.getMarketOutcomes(ref)).map((outcome) => outcome.name)).toEqual(['Yes', 'No']);
    expect(calls).toHaveLength(1);
  });

  it('errors: not found, closed, malformed, rate limited', async () => {
    const { service: api } = service({ 'slug=limited': () => new Response('', { status: 429 }), 'slug=broken-json': () => new Response('{nope') });
    expect(await errorCode(api.getCurrentMarket({ eventSlug: 'does-not-exist', marketSlug: null }))).toBe('NOT_FOUND');
    expect(await errorCode(api.getCurrentMarket({ eventSlug: 'winter-olympics-2026-opening-date', marketSlug: null }))).toBe('UNSUPPORTED_MARKET');
    expect(await errorCode(api.getCurrentMarket({ eventSlug: 'malformed-market', marketSlug: null }))).toBe('INVALID_RESPONSE');
    expect(await errorCode(api.getCurrentMarket({ eventSlug: 'limited', marketSlug: null }))).toBe('RATE_LIMITED');
    expect(await errorCode(api.getCurrentMarket({ eventSlug: 'broken-json', marketSlug: null }))).toBe('INVALID_RESPONSE');
    expect(await errorCode(api.getCurrentMarket({ eventSlug: 'atlantic-named-storms-2026', marketSlug: 'atlantic-named-storms-2026-10-or-fewer' }))).toBe('UNSUPPORTED_MARKET');
    expect(await errorCode(api.getCurrentMarket({ eventSlug: null, marketSlug: null }))).toBe('NOT_FOUND');
  });

  it('malformed responses are never cached', async () => {
    let body = '[{"id":1,"slug":"flaky","title":"Flaky","markets":"oops"}]';
    const { service: api, calls } = service({ 'slug=flaky': () => new Response(body) });
    expect(await errorCode(api.getCurrentMarket({ eventSlug: 'flaky', marketSlug: null }))).toBe('INVALID_RESPONSE');
    body = readFileSync(join(root, 'fixtures/gamma/events/ev-sales-20m-2026.json'), 'utf8').replaceAll('ev-sales-20m-2026', 'flaky');
    expect((await api.getCurrentMarket({ eventSlug: 'flaky', marketSlug: null })).data.kind).toBe('binary');
    expect(calls).toHaveLength(2);
  });

  it('price history per range, and missing history', async () => {
    const { service: api, calls } = service();
    const market = marketOf('ev-sales-20m-2026');
    const week = await api.getMarketHistory(market, '7d');
    expect(week.data).toHaveLength(169);
    expect(calls.at(-1)).toContain('/prices-history?market=');
    expect((await api.getMarketHistory(market, '24h')).data).toHaveLength(145);
    expect(await errorCode(api.getMarketHistory(marketOf('private-lunar-landing-2026'), '7d'))).toBe('MISSING_HISTORY');
    const noToken = { ...market, outcomes: market.outcomes.map((outcome) => ({ ...outcome, tokenId: null })) };
    expect(await errorCode(api.getMarketHistory(noToken, '7d'))).toBe('MISSING_HISTORY');
  });

  it('search normalizes the query and parses results', async () => {
    const payload = JSON.stringify({ events: JSON.parse(readFileSync(join(root, 'fixtures/gamma/events/fed-decision-december-2026.json'), 'utf8')) });
    const { service: api, calls } = service({ '/public-search': () => new Response(payload) });
    const results = await api.searchMarkets('  “fed   decision” ');
    expect(results[0]).toMatchObject({ eventSlug: 'fed-decision-december-2026', marketCount: 4, leader: { label: '25 bps decrease', probability: 0.58 } });
    expect(calls).toEqual([`${GAMMA}/public-search?q=fed+decision&limit_per_type=10`]);
    expect(await api.searchMarkets('a')).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
