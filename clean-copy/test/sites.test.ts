import { describe, expect, it } from 'vitest';
import { activeSites, hostFromPattern, hostOf, originPattern, parseSiteInput, sanitizeSites } from '../src/core/sites';

describe('sites', () => {
  it('parses what people type into an exact host', () => {
    expect(parseSiteInput('news.example.com')).toEqual({ ok: true, host: 'news.example.com' });
    expect(parseSiteInput('  https://Docs.Example.com/some/page?x=1 ')).toEqual({ ok: true, host: 'docs.example.com' });
    expect(parseSiteInput('example.com:8080')).toEqual({ ok: true, host: 'example.com' });
    expect(parseSiteInput('127.0.0.1')).toEqual({ ok: true, host: '127.0.0.1' });
  });

  it('explains what it cannot use', () => {
    expect(parseSiteInput('')).toMatchObject({ ok: false });
    expect(parseSiteInput('chrome://settings')).toMatchObject({ ok: false, message: expect.stringMatching(/http and https/) });
    expect(parseSiteInput('file:///tmp/a.html')).toMatchObject({ ok: false });
    expect(parseSiteInput('exa mple.com')).toMatchObject({ ok: false });
  });

  it('asks for the narrowest pattern: one host, http and https', () => {
    expect(originPattern('docs.example.com')).toBe('*://docs.example.com/*');
    expect(hostFromPattern('*://docs.example.com/*')).toBe('docs.example.com');
    expect(hostFromPattern('https://docs.example.com/*')).toBe('docs.example.com');
    expect(hostFromPattern('*://*.example.com/*')).toBeNull();
    expect(hostFromPattern('<all_urls>')).toBeNull();
  });

  it('reads hosts only from web pages', () => {
    expect(hostOf('https://Example.com./x')).toBe('example.com');
    expect(hostOf('chrome://extensions')).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });

  it('sanitizes the stored list', () => {
    expect(sanitizeSites(['A.com', 'a.com', ' b.org ', 7, 'bad host', ''])).toEqual(['a.com', 'b.org']);
    expect(sanitizeSites('a.com')).toEqual([]);
    expect(sanitizeSites(['a.com', 'b.com', 'c.com'], 2)).toEqual(['a.com', 'b.com']);
  });

  it('is active only where access was granted', () => {
    expect(activeSites(['a.com', 'b.com'], ['*://b.com/*', 'https://c.com/*'])).toEqual(['b.com']);
    expect(activeSites(['a.com', 'b.com'], ['<all_urls>'])).toEqual(['a.com', 'b.com']);
    expect(activeSites(['a.com'], [])).toEqual([]);
  });
});
