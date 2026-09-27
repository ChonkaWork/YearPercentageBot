import { isFiniteNumber, toNonNegative } from '../core/numbers';
import { highestPriced, normalizeChange, normalizeProbability } from '../core/probability';
import { isValidSlug } from '../core/slug';
import type { Market, MarketEvent, Outcome, SearchResult } from '../core/types';
import { DataError } from './errors';

/**
 * Parsing of Polymarket Gamma API responses (https://gamma-api.polymarket.com) into the
 * normalized model. Written from Polymarket's public API documentation; live responses could
 * not be checked from the development environment. Field assumptions:
 *
 * Market object (GET /markets?slug=…, and inside events):
 *   id              string (numbers accepted)                               required
 *   slug            string                                                  required
 *   question        string                                                  required
 *   outcomes        JSON-encoded string array, e.g. "[\"Yes\", \"No\"]"     required (≥ 2)
 *   outcomePrices   JSON-encoded array of decimal strings, "[\"0.62\", \"0.38\"]", same order
 *   clobTokenIds    JSON-encoded array of token id strings, same order (needed for history)
 *   groupItemTitle  short label inside a multi-market event
 *   oneDayPriceChange / oneWeekPriceChange   change of outcomes[0]'s price, probability units
 *   volume24hr, volume1wk                    USD, numbers
 *   volumeNum (or volume as string)          lifetime USD volume
 *   liquidityNum (or liquidity as string)    USD
 *   startDate, endDate                       ISO 8601
 *   closed, active, archived                 booleans
 *   negRisk                                  boolean, market is part of a winner-takes-all event
 *   events                                   array of parent events (only `slug` is used)
 *
 * Event object (GET /events?slug=…):
 *   id, slug, title (required), markets (array, required), negRisk / enableNegRisk,
 *   volume24hr, liquidity, endDate, closed
 *
 * Search (GET /public-search?q=…): { events: Event[] } (other keys ignored).
 *
 * Arrays that arrive as real JSON arrays instead of JSON-encoded strings are accepted too.
 */

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
}

function asText(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function asId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 100);
  if (isFiniteNumber(value)) return String(value);
  return null;
}

function asDate(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Gamma encodes arrays as JSON strings ("[\"Yes\", \"No\"]"). Null when unreadable. */
export function parseEncodedArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reasons a market object can't be used at all. */
type MarketProblem = 'shape' | 'outcomes';

function parseMarketOrProblem(value: unknown): Market | MarketProblem {
  const raw = asRecord(value);
  if (!raw) return 'shape';
  const id = asId(raw.id);
  const slug = asText(raw.slug, 200);
  const question = asText(raw.question);
  if (!id || !slug || !isValidSlug(slug) || !question) return 'shape';

  const names = parseEncodedArray(raw.outcomes);
  if (!names || names.length < 2 || names.some((name) => asText(name, 120) === null)) return 'outcomes';
  const prices = parseEncodedArray(raw.outcomePrices);
  const tokens = parseEncodedArray(raw.clobTokenIds);
  const pricesUsable = prices !== null && prices.length === names.length;
  const tokensUsable = tokens !== null && tokens.length === names.length;

  const outcomes: Outcome[] = names.map((name, index) => ({
    name: asText(name, 120) as string,
    probability: pricesUsable ? normalizeProbability(prices[index]) : null,
    tokenId: tokensUsable ? asId(tokens[index]) : null,
  }));

  return {
    id,
    slug,
    question,
    label: asText(raw.groupItemTitle, 120),
    outcomes,
    probability: outcomes[0]?.probability ?? null,
    change24h: normalizeChange(raw.oneDayPriceChange),
    change7d: normalizeChange(raw.oneWeekPriceChange),
    volume24h: toNonNegative(raw.volume24hr),
    volume7d: toNonNegative(raw.volume1wk),
    volumeTotal: toNonNegative(raw.volumeNum) ?? toNonNegative(raw.volume),
    liquidity: toNonNegative(raw.liquidityNum) ?? toNonNegative(raw.liquidity),
    startDate: asDate(raw.startDate),
    endDate: asDate(raw.endDate),
    closed: raw.closed === true || raw.archived === true || raw.active === false,
  };
}

/** Strict: throws INVALID_RESPONSE for an unreadable market object. */
export function parseGammaMarket(value: unknown): Market {
  const result = parseMarketOrProblem(value);
  if (typeof result === 'string') {
    throw new DataError('INVALID_RESPONSE', result === 'outcomes' ? 'Market has no readable outcomes' : 'Market object is malformed');
  }
  return result;
}

/** Slug of the first parent event listed on a market object, if any. */
export function parentEventSlug(value: unknown): string | null {
  const events = asRecord(value)?.events;
  if (!Array.isArray(events)) return null;
  const slug = asText(asRecord(events[0])?.slug, 200);
  return slug && isValidSlug(slug) ? slug : null;
}

export interface ParsedEvent {
  event: MarketEvent;
  /** Readable markets that are closed (kept to explain why a linked market can't be analyzed). */
  closed: Market[];
}

export function parseGammaEvent(value: unknown): ParsedEvent {
  const raw = asRecord(value);
  if (!raw) throw new DataError('INVALID_RESPONSE', 'Event object is malformed');
  const id = asId(raw.id);
  const slug = asText(raw.slug, 200);
  const title = asText(raw.title);
  if (!id || !slug || !isValidSlug(slug) || !title || !Array.isArray(raw.markets)) {
    throw new DataError('INVALID_RESPONSE', 'Event object is malformed');
  }

  const open: Market[] = [];
  const closed: Market[] = [];
  let unreadable = 0;
  let negRiskMarkets = 0;
  for (const entry of raw.markets) {
    const market = parseMarketOrProblem(entry);
    if (typeof market === 'string') {
      unreadable++;
      continue;
    }
    if (asRecord(entry)?.negRisk === true) negRiskMarkets++;
    // Placeholder markets without prices can't be shown or analyzed.
    if (market.closed) closed.push(market);
    else if (market.probability === null) unreadable++;
    else open.push(market);
  }
  if (raw.markets.length > 0 && unreadable === raw.markets.length) {
    throw new DataError('INVALID_RESPONSE', 'No market in this event could be read');
  }

  const marketCount = open.length + closed.length;
  const mutuallyExclusive = raw.negRisk === true || raw.enableNegRisk === true || (marketCount > 1 && negRiskMarkets === marketCount);

  return {
    event: {
      id,
      slug,
      title,
      mutuallyExclusive,
      markets: open,
      hiddenMarkets: closed.length + unreadable,
      volume24h: toNonNegative(raw.volume24hr),
      liquidity: toNonNegative(raw.liquidityNum) ?? toNonNegative(raw.liquidity),
      endDate: asDate(raw.endDate),
    },
    closed,
  };
}

/** GET /events?slug=… and /markets?slug=… answer with an array; empty means not found. */
export function firstOfList(value: unknown): unknown {
  if (!Array.isArray(value)) throw new DataError('INVALID_RESPONSE', 'Expected a list');
  if (value.length === 0) throw new DataError('NOT_FOUND', 'No result for this slug');
  return value[0];
}

export function parseSearchResponse(value: unknown, limit = 10): SearchResult[] {
  const raw = asRecord(value);
  if (!raw) throw new DataError('INVALID_RESPONSE', 'Search response is malformed');
  // No "events" key at all means nothing matched.
  if (raw.events === undefined || raw.events === null) return [];
  if (!Array.isArray(raw.events)) throw new DataError('INVALID_RESPONSE', 'Search response is malformed');

  const results: SearchResult[] = [];
  for (const entry of raw.events) {
    const event = asRecord(entry);
    const slug = asText(event?.slug, 200);
    const title = asText(event?.title);
    if (!event || !slug || !isValidSlug(slug) || !title || event.closed === true) continue;
    const markets = Array.isArray(event.markets)
      ? event.markets
          .map((market) => parseMarketOrProblem(market))
          .filter((market): market is Market => typeof market !== 'string' && !market.closed && market.probability !== null)
      : [];
    const single = markets.length === 1 ? markets[0] : undefined;
    const leader = markets.length > 1 ? highestPriced(markets) : null;
    results.push({
      eventSlug: slug,
      title,
      marketCount: markets.length,
      probability: single?.probability ?? null,
      outcomeName: single?.outcomes[0]?.name ?? null,
      leader: leader && isFiniteNumber(leader.probability) ? { label: leader.label ?? leader.question, probability: leader.probability } : null,
      volume24h: toNonNegative(event.volume24hr),
      endDate: asDate(event.endDate),
    });
    if (results.length >= limit) break;
  }
  return results;
}
