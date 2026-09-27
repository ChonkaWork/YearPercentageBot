import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePriceHistory } from '../src/data/clob';
import { parseGammaEvent } from '../src/data/gamma';
import type { HistoryRange, Market, PricePoint } from '../src/core/types';

const root = join(import.meta.dirname, '..');

/** "Now" of the fixture price histories (scripts/make-fixture-history.mjs). */
export const FIXTURE_NOW_MS = 1_790_000_000_000;

export function readFixture(path: string): unknown {
  return JSON.parse(readFileSync(join(root, 'fixtures', path), 'utf8'));
}

/** Raw Gamma /events?slug= response. */
export function eventPayload(slug: string): unknown[] {
  return readFixture(`gamma/events/${slug}.json`) as unknown[];
}

export function parsedEvent(slug: string) {
  return parseGammaEvent(eventPayload(slug)[0]);
}

export function marketOf(eventSlug: string, marketSlug?: string): Market {
  const { event } = parsedEvent(eventSlug);
  const market = marketSlug ? event.markets.find((candidate) => candidate.slug === marketSlug) : event.markets[0];
  if (!market) throw new Error(`No market ${marketSlug} in ${eventSlug}`);
  return market;
}

export function historyOf(marketSlug: string, range: HistoryRange = '7d'): PricePoint[] {
  return parsePriceHistory(readFixture(`clob/${marketSlug}.${range}.json`));
}

/** A market with sensible defaults, for engine tests that don't need fixtures. */
export function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: '1',
    slug: 'test-market',
    question: 'Will the test pass?',
    label: null,
    outcomes: [
      { name: 'Yes', probability: 0.5, tokenId: 'token-yes' },
      { name: 'No', probability: 0.5, tokenId: 'token-no' },
    ],
    probability: 0.5,
    change24h: 0,
    change7d: 0,
    volume24h: 10_000,
    volume7d: 70_000,
    volumeTotal: 1_000_000,
    liquidity: 50_000,
    startDate: FIXTURE_NOW_MS - 90 * 24 * 3600 * 1000,
    endDate: FIXTURE_NOW_MS + 90 * 24 * 3600 * 1000,
    closed: false,
    ...overrides,
  };
}

/** Hourly series ending at FIXTURE_NOW_MS built from a price function of "hours ago". */
export function hourlySeries(hours: number, price: (hoursAgo: number) => number): PricePoint[] {
  const points: PricePoint[] = [];
  for (let hoursAgo = hours; hoursAgo >= 0; hoursAgo--) points.push({ t: FIXTURE_NOW_MS - hoursAgo * 3600_000, p: price(hoursAgo) });
  return points;
}
