import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckFailure, fetchPage, MAX_BODY_BYTES, setFetchTimeout } from '../src/background/fetchPage';

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function failure(url = 'https://example.com/') {
  try {
    await fetchPage(url);
  } catch (error) {
    if (error instanceof CheckFailure) return error.error;
    throw error;
  }
  throw new Error('expected a failure');
}

afterEach(() => {
  vi.unstubAllGlobals();
  setFetchTimeout(20_000);
});

describe('fetchPage', () => {
  it('fetches like a normal visit: cookies, redirects followed, no cache', async () => {
    const spy = stubFetch(async () => {
      const response = new Response('<html><body>Hi</body></html>', { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://example.com/final' });
      return response;
    });
    const page = await fetchPage('https://example.com/start');
    expect(page).toEqual({ kind: 'html', body: '<html><body>Hi</body></html>', finalUrl: 'https://example.com/final' });
    const init = spy.mock.calls[0]![1];
    expect(init).toMatchObject({ credentials: 'include', redirect: 'follow', cache: 'no-store' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports HTTP errors with status and Retry-After', async () => {
    stubFetch(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
    expect(await failure()).toMatchObject({ code: 'http', status: 429, retryAfterSeconds: 120 });
  });

  it('tells offline apart from an unreachable site', async () => {
    stubFetch(async () => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('navigator', { onLine: false });
    expect((await failure()).code).toBe('offline');
    vi.stubGlobal('navigator', { onLine: true });
    expect((await failure()).code).toBe('network');
  });

  it('times out with an abort', async () => {
    setFetchTimeout(20);
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    expect((await failure()).code).toBe('timeout');
  });

  it('refuses non-HTML responses, but reads plain text and sniffs untyped HTML', async () => {
    stubFetch(async () => new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }));
    expect(await failure()).toMatchObject({ code: 'not-html', message: expect.stringContaining('application/json') });

    stubFetch(async () => new Response('plain words', { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    expect((await fetchPage('https://example.com/')).kind).toBe('text');

    stubFetch(async () => new Response(new Blob(['<!doctype html><p>x'])));
    expect((await fetchPage('https://example.com/')).kind).toBe('html');

    stubFetch(async () => new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])])));
    expect((await failure()).code).toBe('not-html');
  });

  it('caps the size, by header and while streaming', async () => {
    stubFetch(async () => new Response('x', { headers: { 'content-type': 'text/html', 'content-length': String(MAX_BODY_BYTES + 1) } }));
    expect((await failure()).code).toBe('too-large');

    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    stubFetch(async () => new Response(stream, { headers: { 'content-type': 'text/html' } }));
    expect((await failure()).code).toBe('too-large');
  });

  it('decodes legacy charsets from the header', async () => {
    const bytes = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    stubFetch(async () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=windows-1251' } }));
    expect((await fetchPage('https://example.com/')).body).toBe('Привет');
  });
});
