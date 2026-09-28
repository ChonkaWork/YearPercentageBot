import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FEATURE_LABELS, FEATURES, isPaused, MAX_PAUSE_MS, pauseUntil, sanitizeSettings } from '../src/core/settings';
import { DEFAULT_SCHEDULE } from '../src/core/schedule';

describe('sanitizeSettings', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const raw of [undefined, null, 'x', 42, []]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults: on; Shorts, home, Up next and end screens hidden; comments shown; calm home page', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.hide).toEqual({ shorts: true, home: true, related: true, endscreen: true, comments: false });
    expect(DEFAULT_SETTINGS.homeMode).toBe('calm');
    expect(DEFAULT_SETTINGS.schedule).toEqual(DEFAULT_SCHEDULE);
    expect(DEFAULT_SETTINGS.subscriptionsOnly).toBe(false);
  });

  it('falls back per field', () => {
    const settings = sanitizeSettings({
      enabled: 'no',
      hide: { shorts: false, comments: 'yes', related: false, bogus: true },
      homeMode: 'feed',
      pausedUntil: -5,
      schedule: { enabled: true, days: [6] },
      allowlist: [{ handle: '@calmcoding' }, 'junk'],
      subscriptionsOnly: 1,
    });
    expect(settings.enabled).toBe(true);
    expect(settings.hide).toEqual({ shorts: false, home: true, related: false, endscreen: true, comments: false });
    expect(settings.homeMode).toBe('calm');
    expect(settings.pausedUntil).toBe(0);
    expect(settings.schedule).toEqual({ ...DEFAULT_SCHEDULE, enabled: true, days: [6] });
    expect(settings.allowlist).toEqual([{ id: null, handle: '@calmcoding', name: '@calmcoding' }]);
    expect(settings.subscriptionsOnly).toBe(false);
  });

  it('keeps valid values', () => {
    const raw = {
      enabled: false,
      hide: { shorts: false, home: false, related: false, endscreen: false, comments: true },
      homeMode: 'subscriptions',
      pausedUntil: 1_700_000_000_000.4,
      subscriptionsOnly: true,
    };
    const settings = sanitizeSettings(raw);
    expect(settings).toMatchObject({ ...raw, pausedUntil: 1_700_000_000_000 });
    expect(sanitizeSettings(settings)).toEqual(settings);
  });

  it('every feature has a label', () => {
    for (const feature of FEATURES) expect(FEATURE_LABELS[feature].title).toBeTruthy();
  });
});

describe('pause', () => {
  it('lasts 15 minutes and ends on time', () => {
    const now = 1_000_000;
    const settings = { ...DEFAULT_SETTINGS, pausedUntil: pauseUntil(now) };
    expect(settings.pausedUntil - now).toBe(15 * 60_000);
    expect(isPaused(settings, now)).toBe(true);
    expect(isPaused(settings, now + 15 * 60_000 - 1)).toBe(true);
    expect(isPaused(settings, now + 15 * 60_000)).toBe(false);
  });

  it('ignores a pause too far ahead (clock jumped, corrupt data) and zero', () => {
    const now = 1_000_000;
    expect(isPaused({ ...DEFAULT_SETTINGS, pausedUntil: now + MAX_PAUSE_MS + 1 }, now)).toBe(false);
    expect(isPaused({ ...DEFAULT_SETTINGS, pausedUntil: 0 }, now)).toBe(false);
  });
});
