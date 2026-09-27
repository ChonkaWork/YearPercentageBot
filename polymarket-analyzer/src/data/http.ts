import { DataError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * GET a JSON document. Every failure becomes a DataError with a code the UI understands.
 * A caller's own abort (e.g. a newer search replaced this one) is rethrown as is.
 */
export async function getJson(url: string, options: { fetch: FetchLike; signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'GET',
      signal,
      headers: { accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) throw new DataError('TIMEOUT', 'Request timed out');
    throw new DataError('NETWORK', 'Network request failed');
  }

  if (response.status === 404) throw new DataError('NOT_FOUND', 'Not found', { status: 404 });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new DataError('RATE_LIMITED', 'Rate limited', {
      status: 429,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 3600 ? { retryAfterSeconds: Math.ceil(retryAfter) } : {}),
    });
  }
  if (!response.ok) throw new DataError('UNAVAILABLE', `HTTP ${response.status}`, { status: response.status });

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) throw new DataError('TIMEOUT', 'Request timed out');
    throw new DataError('NETWORK', 'Response was interrupted');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DataError('INVALID_RESPONSE', 'Response is not valid JSON');
  }
}
