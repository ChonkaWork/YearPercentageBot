import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SPEED_KEY,
  isSpeedKey,
  parseGlobalSpeed,
  parseSiteSpeed,
  resolveStartSpeed,
  siteKeysToPrune,
  siteSpeedKey,
} from '../src/core/memory';

describe('remembered speeds', () => {
  it('parses stored values defensively', () => {
    expect(parseGlobalSpeed(1.5)).toBe(1.5);
    expect(parseGlobalSpeed(99)).toBe(16);
    expect(parseGlobalSpeed('1.5')).toBeNull();
    expect(parseGlobalSpeed(Number.NaN)).toBeNull();
    expect(parseSiteSpeed({ speed: 2, at: 5 })).toEqual({ speed: 2, at: 5 });
    expect(parseSiteSpeed({ speed: 2 })).toEqual({ speed: 2, at: 0 });
    expect(parseSiteSpeed({ speed: 'x' })).toBeNull();
    expect(parseSiteSpeed(2)).toBeNull();
  });

  it('global mode: the last speed used anywhere', () => {
    expect(resolveStartSpeed({ global: 1.7, site: { speed: 2.5, at: 1 } }, false, 'youtube.com')).toBe(1.7);
    expect(resolveStartSpeed({ global: null, site: null }, false, 'youtube.com')).toBe(1);
  });

  it("per-site mode: the site's own speed, 1× for new sites", () => {
    expect(resolveStartSpeed({ global: 1.7, site: { speed: 2.5, at: 1 } }, true, 'youtube.com')).toBe(2.5);
    expect(resolveStartSpeed({ global: 1.7, site: null }, true, 'news.example')).toBe(1);
    // file:// and similar have no host: fall back to the global speed.
    expect(resolveStartSpeed({ global: 1.7, site: null }, true, '')).toBe(1.7);
  });

  it('a per-site default (Pro) wins over both memories', () => {
    const remembered = { global: 1.7, site: { speed: 2.5, at: 1 } };
    expect(resolveStartSpeed(remembered, false, 'youtube.com', 1.25)).toBe(1.25);
    expect(resolveStartSpeed(remembered, true, 'youtube.com', 1)).toBe(1);
    expect(resolveStartSpeed(remembered, true, 'youtube.com', 99)).toBe(16);
    expect(resolveStartSpeed(remembered, true, 'youtube.com', null)).toBe(2.5);
    expect(resolveStartSpeed(remembered, false, '', 1.25)).toBe(1.7);
  });

  it('knows its storage keys', () => {
    expect(siteSpeedKey('youtube.com')).toBe('speed:site:youtube.com');
    expect(isSpeedKey(GLOBAL_SPEED_KEY)).toBe(true);
    expect(isSpeedKey('speed:site:a.com')).toBe(true);
    expect(isSpeedKey('settings')).toBe(false);
  });

  it('prunes the oldest site entries and broken ones', () => {
    const items: Record<string, unknown> = {
      settings: {},
      [GLOBAL_SPEED_KEY]: 1.5,
      'speed:site:old.com': { speed: 2, at: 1 },
      'speed:site:mid.com': { speed: 2, at: 2 },
      'speed:site:new.com': { speed: 2, at: 3 },
      'speed:site:broken.com': 'x',
      'speed:site:': { speed: 1, at: 9 },
    };
    expect(siteKeysToPrune(items, 2).sort()).toEqual(['speed:site:', 'speed:site:broken.com', 'speed:site:old.com']);
    expect(siteKeysToPrune(items, 10).sort()).toEqual(['speed:site:', 'speed:site:broken.com']);
  });
});
