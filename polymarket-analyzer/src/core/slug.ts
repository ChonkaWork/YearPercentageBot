import type { MarketRef } from './types';

/**
 * Market detection from polymarket.com URLs. Supported forms (with an optional locale
 * prefix such as /es/ and any query string or hash):
 *
 *   /event/<event-slug>
 *   /event/<event-slug>/<market-slug>
 *   /market/<market-slug>
 */

const HOSTS = new Set(['polymarket.com', 'www.polymarket.com']);
const SLUG = /^[a-z0-9](?:[a-z0-9_-]{0,198}[a-z0-9])?$/i;

export function isPolymarketUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value);
}

export function parseMarketUrl(url: string | null | undefined): MarketRef | null {
  if (!url || !isPolymarketUrl(url)) return null;
  const segments = new URL(url).pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return '';
      }
    });
  // Optional locale prefix: "es", "pt-br", "zh".
  if (segments.length > 1 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] ?? '')) {
    segments.shift();
  }
  const [kind, first, second] = segments;
  if (kind === 'event' && isValidSlug(first)) {
    return { eventSlug: first, marketSlug: isValidSlug(second) ? second : null };
  }
  if (kind === 'market' && isValidSlug(first)) {
    return { eventSlug: null, marketSlug: first };
  }
  return null;
}

/** The polymarket.com page for a market (for "Open on Polymarket" links). */
export function marketPageUrl(ref: MarketRef): string {
  if (ref.eventSlug && ref.marketSlug) {
    return `https://polymarket.com/event/${encodeURIComponent(ref.eventSlug)}/${encodeURIComponent(ref.marketSlug)}`;
  }
  if (ref.eventSlug) return `https://polymarket.com/event/${encodeURIComponent(ref.eventSlug)}`;
  return `https://polymarket.com/market/${encodeURIComponent(ref.marketSlug ?? '')}`;
}

export function refKey(ref: MarketRef): string {
  return `${ref.eventSlug ?? ''}/${ref.marketSlug ?? ''}`;
}

export function isMarketRef(value: unknown): value is MarketRef {
  if (!value || typeof value !== 'object') return false;
  const { eventSlug, marketSlug } = value as Record<string, unknown>;
  const eventOk = eventSlug === null || isValidSlug(eventSlug);
  const marketOk = marketSlug === null || isValidSlug(marketSlug);
  return eventOk && marketOk && (eventSlug !== null || marketSlug !== null);
}

/** Inverse of refKey (null for anything that isn't a valid key). */
export function refFromKey(key: string): MarketRef | null {
  const slash = key.indexOf('/');
  if (slash < 0) return null;
  const ref = { eventSlug: key.slice(0, slash) || null, marketSlug: key.slice(slash + 1) || null };
  return isMarketRef(ref) ? ref : null;
}
