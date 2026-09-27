import type { ProviderId } from '../core/types';

export type MarketErrorCode =
  /** The provider refuses this client, usually by location (HTTP 451, 403). */
  | 'blocked'
  /** Server-side failure (5xx) or an unexpected status. */
  | 'unavailable'
  /** HTTP 429/418. retryAfterMs says when to try again. */
  | 'rate-limited'
  /** The provider doesn't list this market. */
  | 'invalid-symbol'
  /** The response didn't match the documented format. */
  | 'malformed'
  /** The request never got a response (offline, DNS, connection reset). */
  | 'network'
  | 'timeout';

export class MarketDataError extends Error {
  override readonly name = 'MarketDataError';

  constructor(
    readonly code: MarketErrorCode,
    message: string,
    readonly provider: ProviderId | null = null,
    readonly status: number | null = null,
    /** For rate limits: milliseconds until the provider accepts requests again. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
