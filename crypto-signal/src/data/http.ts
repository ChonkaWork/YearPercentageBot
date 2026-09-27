import type { ProviderId } from '../core/types';
import { MarketDataError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or undefined when the body wasn't JSON. */
  body: unknown;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** Used when a 429 has no usable Retry-After header. */
export const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * GET a URL and parse the JSON body. Network failures and timeouts become MarketDataErrors;
 * HTTP error statuses are returned so the provider can map them (it knows its error format).
 * An abort from the caller's signal is rethrown as is.
 */
export async function getJson(
  url: string,
  provider: ProviderId,
  options: HttpOptions & { signal?: AbortSignal } = {},
): Promise<HttpResponse> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: response.status, headers: response.headers, body };
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (timedOut) throw new MarketDataError('timeout', 'The request timed out.', provider);
    throw new MarketDataError('network', 'The request failed before a response arrived.', provider);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Retry-After as delta-seconds or an HTTP date. Null when missing or unusable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let ms: number | null = null;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) ms = date - now;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms));
}

/**
 * The status mapping both providers share. Returns null for statuses the provider maps itself
 * (400 and 404, whose meaning depends on the error body).
 */
export function commonStatusError(response: HttpResponse, provider: ProviderId, label: string, now: number): MarketDataError | null {
  const { status } = response;
  if (status === 429 || status === 418) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now) ?? DEFAULT_RETRY_AFTER_MS;
    return new MarketDataError('rate-limited', `${label} is rate limiting requests.`, provider, status, retryAfter);
  }
  if (status === 451 || status === 403) {
    return new MarketDataError('blocked', `${label} is not available from this location.`, provider, status);
  }
  if (status >= 500) return new MarketDataError('unavailable', `${label} is unavailable right now.`, provider, status);
  if (status < 200 || status >= 300) {
    if (status === 400 || status === 404) return null;
    return new MarketDataError('unavailable', `${label} answered with an unexpected status.`, provider, status);
  }
  return null;
}

/** Documented decimal strings like "64231.50000000" or "-1.234". Rejects "", "NaN", "1e5", "Infinity". */
export function parseDecimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
