import { contentKind, decodeBody, looksLikeHtml, mimeOf } from '../core/content';
import { checkError, parseRetryAfter } from '../core/errors';
import type { CheckError, ErrorCode } from '../core/types';

/** A check that failed in a way the user should see. */
export class CheckFailure extends Error {
  constructor(readonly error: CheckError) {
    super(error.message);
    this.name = 'CheckFailure';
  }
}

export function fail(code: ErrorCode, extra?: Parameters<typeof checkError>[1]): CheckFailure {
  return new CheckFailure(checkError(code, extra));
}

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
let timeoutMs = 20_000;

/** Test builds shorten the timeout so the e2e suite doesn't wait 20 seconds. */
export function setFetchTimeout(ms: number): void {
  timeoutMs = ms;
}

export interface FetchedPage {
  kind: 'html' | 'text';
  body: string;
  /** After redirects. */
  finalUrl: string;
}

/**
 * Fetches a watched page like a normal visit would (cookies included where the browser
 * allows), following redirects, with a timeout and a size cap.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.1' },
      });
    } catch {
      throw networkFailure(controller.signal);
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw fail('http', {
        status: response.status,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after'), Date.now()),
      });
    }

    const contentType = response.headers.get('content-type');
    const kind = contentKind(contentType);
    if (kind === 'other') {
      void response.body?.cancel().catch(() => undefined);
      throw fail('not-html', { detail: `It returns ${mimeOf(contentType)}.` });
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw fail('too-large');
    }

    const bytes = await readCapped(response, controller.signal);
    const body = decodeBody(bytes, contentType);
    let resolved: 'html' | 'text';
    if (kind === 'unknown') {
      if (!looksLikeHtml(body.slice(0, 2048))) throw fail('not-html');
      resolved = 'html';
    } else {
      resolved = kind;
    }
    return { kind: resolved, body, finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function networkFailure(signal: AbortSignal): CheckFailure {
  if (signal.aborted) return fail('timeout');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return fail('offline');
  return fail('network');
}

async function readCapped(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw fail('too-large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    throw networkFailure(signal);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
