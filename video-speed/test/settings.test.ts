import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYS } from '../src/core/keys';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings';

describe('sanitizeSettings', () => {
  it('returns defaults for missing or broken data', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ step: 0.1, preferredSpeed: 1.8, seekSeconds: 10, rememberPerSite: false, includeAudio: false, showController: true });
    expect(DEFAULT_SETTINGS.keys).toEqual(DEFAULT_KEYS);
  });

  it('falls back per field', () => {
    const result = sanitizeSettings({ step: 'fast', preferredSpeed: 2.5, rememberPerSite: 'yes', includeAudio: true, blocklist: ['Vimeo.com', '??'] });
    expect(result.step).toBe(0.1);
    expect(result.preferredSpeed).toBe(2.5);
    expect(result.rememberPerSite).toBe(false);
    expect(result.includeAudio).toBe(true);
    expect(result.blocklist).toEqual(['vimeo.com']);
  });

  it('clamps and rounds numbers (numeric strings from inputs are accepted)', () => {
    expect(sanitizeSettings({ step: 5 }).step).toBe(2);
    expect(sanitizeSettings({ step: 0 }).step).toBe(0.01);
    expect(sanitizeSettings({ step: '0.25' }).step).toBe(0.25);
    expect(sanitizeSettings({ step: 0.123 }).step).toBe(0.12);
    expect(sanitizeSettings({ preferredSpeed: 99 }).preferredSpeed).toBe(16);
    expect(sanitizeSettings({ preferredSpeed: 0 }).preferredSpeed).toBe(0.0625);
    expect(sanitizeSettings({ preferredSpeed: '' }).preferredSpeed).toBe(1.8);
    expect(sanitizeSettings({ seekSeconds: 2.6 }).seekSeconds).toBe(3);
    expect(sanitizeSettings({ seekSeconds: -4 }).seekSeconds).toBe(1);
    expect(sanitizeSettings({ seekSeconds: 1e9 }).seekSeconds).toBe(600);
    expect(sanitizeSettings({ seekSeconds: Number.NaN }).seekSeconds).toBe(10);
  });

  it('keeps key bindings valid and unique', () => {
    const result = sanitizeSettings({ keys: { faster: 'KeyS', slower: 'KeyS' } });
    expect(result.keys.slower).toBe('KeyS');
    expect(result.keys.faster).toBeNull();
  });
});
