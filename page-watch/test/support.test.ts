import { describe, expect, it } from 'vitest';
import { patternMatcher, watchesForPatterns } from '../src/core/permissions';
import { charsetFromContentType, contentKind, decodeBody, looksLikeHtml, sniffMetaCharset } from '../src/core/content';
import { chooseElementBaseline, choosePageBaseline, looksCollapsed, similarity } from '../src/core/creation';
import { errorLabel, httpErrorMessage, isTransient, parseRetryAfter } from '../src/core/errors';
import { createLimiter } from '../src/core/limiter';
import { catchUpDelay, MAX_BACKOFF_MS, MINUTE_MS, nextCheckDelay } from '../src/core/schedule';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings';
import type { Watch } from '../src/core/types';
import { hostLabel, normalizeWatchUrl, originPattern, shortUrl } from '../src/core/url';

describe('schedule', () => {
  it('uses the interval, doubles per error, caps at a day, jitters ±10%', () => {
    expect(nextCheckDelay(15, 0, () => 0.5)).toBe(15 * MINUTE_MS);
    expect(nextCheckDelay(15, 3, () => 0.5)).toBe(60 * MINUTE_MS);
    expect(nextCheckDelay(60, 20, () => 0.5)).toBe(MAX_BACKOFF_MS);
    expect(nextCheckDelay(60, 0, () => 0)).toBe(54 * MINUTE_MS);
    expect(nextCheckDelay(60, 0, () => 1)).toBe(66 * MINUTE_MS);
  });

  it('never goes under a minute, honours Retry-After up to a day', () => {
    expect(nextCheckDelay(5, 0, () => 0, 5)).toBe(4.5 * MINUTE_MS);
    expect(nextCheckDelay(5, 0, () => 0.5, 7200)).toBe(120 * MINUTE_MS);
    expect(nextCheckDelay(5, 0, () => 0.5, 10 ** 9)).toBe(MAX_BACKOFF_MS);
  });

  it('spreads catch-up checks', () => {
    expect(catchUpDelay(() => 0, 0)).toBe(MINUTE_MS);
    expect(catchUpDelay(() => 0, 3)).toBeGreaterThan(catchUpDelay(() => 0, 2));
  });
});

describe('creation baseline', () => {
  it('keeps the first candidate that finds the same text', () => {
    const result = chooseElementBaseline('$129', [
      { selector: '#gone', matchCount: 0, text: null, truncated: false },
      { selector: 'p.price', matchCount: 1, text: 'Loading', truncated: false },
      { selector: 'body > p', matchCount: 1, text: '$129', truncated: false },
    ]);
    expect(result).toEqual({ ok: true, selector: 'body > p', text: '$129', truncated: false });
  });

  it('picks the closest text when nothing is identical', () => {
    const result = chooseElementBaseline('Senior Engineer Berlin 3 days ago', [
      { selector: 'a', matchCount: 1, text: 'Footer links', truncated: false },
      { selector: 'b', matchCount: 1, text: 'Senior Engineer Berlin 4 days ago', truncated: false },
    ]);
    expect(result).toMatchObject({ ok: true, selector: 'b' });
  });

  it('detects JavaScript-rendered elements', () => {
    const missing = chooseElementBaseline('$129', [{ selector: '#price', matchCount: 0, text: null, truncated: false }]);
    expect(missing).toMatchObject({ ok: false, error: { code: 'js-rendered' } });
    expect(missing.ok ? '' : missing.error.message).toMatch(/renders it with JavaScript/);
    const empty = chooseElementBaseline('$129', [{ selector: '#price', matchCount: 1, text: '', truncated: false }]);
    expect(empty).toMatchObject({ ok: false, error: { code: 'js-rendered' } });
    const placeholder = chooseElementBaseline('Price $129', [{ selector: '#price', matchCount: 1, text: 'Loading…', truncated: false }]);
    expect(placeholder).toMatchObject({ ok: false, error: { code: 'js-rendered' } });
  });

  it('detects JavaScript-rendered pages', () => {
    const live = 'Welcome to the app. '.repeat(50);
    expect(choosePageBaseline(live, { text: '', truncated: false })).toMatchObject({ ok: false, error: { code: 'js-rendered' } });
    expect(choosePageBaseline(live, { text: 'Menu Login Footer', truncated: false })).toMatchObject({ ok: false, error: { code: 'js-rendered' } });
    expect(choosePageBaseline('OK', { text: 'OK', truncated: false })).toMatchObject({ ok: true });
    expect(choosePageBaseline(null, { text: '', truncated: false })).toMatchObject({ ok: false, error: { code: 'empty' } });
    expect(choosePageBaseline(live, { text: live, truncated: false })).toMatchObject({ ok: true, selector: null });
  });

  it('flags pages that collapse later', () => {
    expect(looksCollapsed('x'.repeat(5000), 'Just a moment...')).toBe(true);
    expect(looksCollapsed('x'.repeat(5000), 'x'.repeat(3000))).toBe(false);
    expect(looksCollapsed('short', 'shorter')).toBe(false);
    expect(looksCollapsed('anything', '')).toBe(true);
  });

  it('measures word overlap', () => {
    expect(similarity('a b c', 'a b c')).toBe(1);
    expect(similarity('a b', 'c d')).toBe(0);
    expect(similarity('a b c d', 'a b c e')).toBeCloseTo(3 / 5);
  });
});

describe('limiter', () => {
  it('runs at most N tasks at once, in order, and dedupes keys', async () => {
    const limiter = createLimiter(2);
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const task = (name: string) => async () => {
      running++;
      peak = Math.max(peak, running);
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return name;
    };
    const first = limiter.run('a', task('a'));
    const duplicate = limiter.run('a', task('a2'));
    expect(duplicate).toBe(first);
    const results = await Promise.all([first, limiter.run('b', task('b')), limiter.run('c', task('c')), limiter.run('d', task('d'))]);
    expect(results).toEqual(['a', 'b', 'c', 'd']);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(peak).toBe(2);
  });

  it('runs a key again once it finished, survives failures, reports idle', async () => {
    const limiter = createLimiter(1);
    let idle = 0;
    limiter.onIdle(() => idle++);
    await expect(limiter.run('x', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    let calls = 0;
    await limiter.run('x', async () => calls++);
    await limiter.run('x', async () => calls++);
    expect(calls).toBe(2);
    expect(idle).toBe(3);
    expect(limiter.has('x')).toBe(false);
  });
});

describe('content decoding', () => {
  it('classifies content types', () => {
    expect(contentKind('text/html; charset=utf-8')).toBe('html');
    expect(contentKind('application/xhtml+xml')).toBe('html');
    expect(contentKind('text/plain')).toBe('text');
    expect(contentKind('application/json')).toBe('other');
    expect(contentKind(null)).toBe('unknown');
    expect(looksLikeHtml('<!-- hi -->\n<!DOCTYPE html><html>')).toBe(true);
    expect(looksLikeHtml('{"a":1}')).toBe(false);
  });

  it('reads the charset from the header or a meta tag', () => {
    expect(charsetFromContentType('text/html; charset="Windows-1251"')).toBe('windows-1251');
    expect(sniffMetaCharset('<head><meta charset=shift_jis>')).toBe('shift_jis');
    expect(sniffMetaCharset('<meta http-equiv="Content-Type" content="text/html; charset=koi8-r">')).toBe('koi8-r');
  });

  it('decodes legacy encodings instead of garbling them', () => {
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет"
    expect(decodeBody(cp1251, 'text/html; charset=windows-1251')).toBe('Привет');
    const withMeta = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1251">'), ...cp1251]);
    expect(decodeBody(withMeta, 'text/html')).toContain('Привет');
    expect(decodeBody(new TextEncoder().encode('héllo'), 'text/html')).toBe('héllo');
    expect(decodeBody(new TextEncoder().encode('<meta charset="utf-16">ok'), 'text/html')).toContain('ok');
  });
});

describe('urls and permissions', () => {
  it('only accepts http(s) pages and drops the fragment', () => {
    expect(normalizeWatchUrl('https://example.com/a?b=1#top')).toBe('https://example.com/a?b=1');
    expect(normalizeWatchUrl('chrome://extensions')).toBeNull();
    expect(normalizeWatchUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeWatchUrl('https://user:pw@example.com')).toBeNull();
    expect(normalizeWatchUrl(42)).toBeNull();
  });

  it('builds per-origin patterns and labels', () => {
    expect(originPattern('https://shop.example.com/p/1?x=2')).toBe('https://shop.example.com/*');
    expect(originPattern('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/*');
    expect(hostLabel('https://www.example.com/x')).toBe('example.com');
    expect(shortUrl('https://www.example.com/a/b?c=1')).toBe('example.com/a/b?c=1');
  });

  it('matches removed permission patterns to watches', () => {
    const watches = [{ url: 'https://a.example.com/x' }, { url: 'http://b.test:8080/y' }, { url: 'https://c.org/' }] as Watch[];
    expect(watchesForPatterns(watches, ['https://a.example.com/*']).map((w) => w.url)).toEqual(['https://a.example.com/x']);
    expect(watchesForPatterns(watches, ['*://*.example.com/*'])).toHaveLength(1);
    expect(watchesForPatterns(watches, ['https://*/*'])).toHaveLength(2);
    expect(watchesForPatterns(watches, ['http://b.test:8080/*'])).toHaveLength(1);
    expect(watchesForPatterns(watches, ['http://b.test:9090/*'])).toHaveLength(0);
    expect(patternMatcher('<all_urls>')('https://x.y')).toBe(true);
  });
});

describe('errors and settings', () => {
  it('explains HTTP errors and classifies transient ones', () => {
    expect(httpErrorMessage(403)).toMatch(/sign in/);
    expect(httpErrorMessage(404)).toMatch(/not found/i);
    expect(httpErrorMessage(503)).toMatch(/server error/);
    expect(isTransient({ code: 'http', status: 503 })).toBe(true);
    expect(isTransient({ code: 'http', status: 404 })).toBe(false);
    expect(isTransient({ code: 'selector' })).toBe(false);
    expect(isTransient({ code: 'offline' })).toBe(true);
    expect(errorLabel({ code: 'http', status: 500 })).toBe('HTTP 500');
  });

  it('parses Retry-After', () => {
    expect(parseRetryAfter('120', 0)).toBe(120);
    expect(parseRetryAfter(new Date(60_000).toUTCString(), 0)).toBe(60);
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  it('sanitizes settings', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ notifyChanges: false, defaultIntervalMinutes: 7 })).toEqual({ ...DEFAULT_SETTINGS, notifyChanges: false });
  });
});
