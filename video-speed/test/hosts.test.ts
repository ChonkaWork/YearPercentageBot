import { describe, expect, it } from 'vitest';
import {
  blockingEntry,
  displayHost,
  entriesBlocking,
  hostMatches,
  MAX_BLOCKLIST,
  normalizeHost,
  sanitizeBlocklist,
  siteHostOf,
} from '../src/core/hosts';

describe('normalizeHost', () => {
  it('extracts the hostname from what people paste', () => {
    expect(normalizeHost('example.com')).toBe('example.com');
    expect(normalizeHost('  Example.COM  ')).toBe('example.com');
    expect(normalizeHost('https://www.youtube.com/watch?v=abc')).toBe('youtube.com');
    expect(normalizeHost('http://localhost:8080/x')).toBe('localhost');
    expect(normalizeHost('m.example.com/path#frag')).toBe('m.example.com');
    expect(normalizeHost('example.com:443')).toBe('example.com');
    expect(normalizeHost('*.example.com')).toBe('example.com');
    expect(normalizeHost('.example.com.')).toBe('example.com');
    expect(normalizeHost('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHost('[::1]')).toBe('[::1]');
  });

  it('converts international names to punycode, like location.hostname', () => {
    expect(normalizeHost('пример.укр')).toBe('xn--e1afmkfd.xn--j1amh');
    expect(normalizeHost('https://Bücher.example/')).toBe('xn--bcher-kva.example');
  });

  it('rejects things that are not hostnames', () => {
    for (const input of ['', '   ', 'not a site!', 'user@example.com', 'a b.com', 'exa_mple..com', '-bad.com', 42, null, undefined, {}]) {
      expect(normalizeHost(input), String(input)).toBeNull();
    }
  });
});

describe('matching', () => {
  it('matches the host and its subdomains only', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('example.com', 'www.example.com')).toBe(true);
    expect(hostMatches('example.com', 'a.b.example.com')).toBe(true);
    expect(hostMatches('example.com', 'notexample.com')).toBe(false);
    expect(hostMatches('example.com', 'example.com.evil.net')).toBe(false);
    expect(hostMatches('example.com', '')).toBe(false);
    expect(hostMatches('', 'example.com')).toBe(false);
    expect(hostMatches('example.com', 'EXAMPLE.com.')).toBe(true);
  });

  it('finds the blocking entry and every entry to remove', () => {
    const list = ['music.example.com', 'example.com', 'other.org'];
    expect(blockingEntry(list, 'music.example.com')).toBe('music.example.com');
    expect(blockingEntry(list, 'news.other.org')).toBe('other.org');
    expect(blockingEntry(list, 'example.net')).toBeNull();
    expect(entriesBlocking(list, 'music.example.com')).toEqual(['music.example.com', 'example.com']);
  });

  it('sanitizes stored lists', () => {
    expect(sanitizeBlocklist(['YouTube.com', 'https://www.youtube.com/', 'bad site', 7, 'vimeo.com'])).toEqual(['youtube.com', 'vimeo.com']);
    expect(sanitizeBlocklist('youtube.com')).toEqual([]);
    expect(sanitizeBlocklist(Array.from({ length: 900 }, (_, i) => `site${i}.com`))).toHaveLength(MAX_BLOCKLIST);
  });
});

describe('siteHostOf', () => {
  it('uses the top frame for embedded players', () => {
    expect(siteHostOf('player.vimeo.com', ['https://course.example', 'https://school.example.org'])).toBe('school.example.org');
    expect(siteHostOf('www.youtube.com', [])).toBe('www.youtube.com');
    expect(siteHostOf('', ['http://127.0.0.1:8080'])).toBe('127.0.0.1');
    expect(siteHostOf('Frame.Example', ['null'])).toBe('frame.example');
  });

  it('shortens for display', () => {
    expect(displayHost('www.youtube.com')).toBe('youtube.com');
    expect(displayHost('m.youtube.com')).toBe('m.youtube.com');
  });
});
