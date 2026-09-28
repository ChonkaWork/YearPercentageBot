import { describe, expect, it } from 'vitest';
import { computeFocus, focusStatus, sameEffect, SUBSCRIPTIONS_PATH, type Access, type PageInfo } from '../src/core/focus';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../src/core/settings';

const EARLY: Access = { plan: 'free', earlyAccess: true };
const FREE: Access = { plan: 'free', earlyAccess: false };
const PRO: Access = { plan: 'pro', earlyAccess: false };
const NOW = Date.parse('2026-09-30T10:00:00Z'); // Wednesday
const CALM = { id: null, handle: '@calmcoding', name: 'Calm Coding' };

const settingsWith = (patch: Partial<Settings>): Settings => sanitizeSettings({ ...DEFAULT_SETTINGS, ...patch });
const page = (path: string, channel: PageInfo['channel'] = null): PageInfo => {
  const url = new URL(path, 'https://www.youtube.com');
  return { pathname: url.pathname, search: url.search, channel };
};

describe('focusStatus', () => {
  it('on / off / paused', () => {
    expect(focusStatus(DEFAULT_SETTINGS, EARLY, NOW)).toEqual({ state: 'on', until: null });
    expect(focusStatus(settingsWith({ enabled: false }), EARLY, NOW)).toEqual({ state: 'off', until: null });
    expect(focusStatus(settingsWith({ pausedUntil: NOW + 60_000 }), EARLY, NOW)).toEqual({ state: 'paused', until: NOW + 60_000 });
    expect(focusStatus(settingsWith({ pausedUntil: NOW - 1 }), EARLY, NOW).state).toBe('on');
    // Off wins over paused.
    expect(focusStatus(settingsWith({ enabled: false, pausedUntil: NOW + 60_000 }), EARLY, NOW).state).toBe('off');
  });

  it('schedule: on inside the window (until its end), waiting outside (until its start)', () => {
    const schedule = { enabled: true, days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60, timeZone: 'UTC' };
    const settings = settingsWith({ schedule });
    expect(focusStatus(settings, EARLY, NOW)).toEqual({ state: 'on', until: Date.parse('2026-09-30T17:00:00Z') });
    expect(focusStatus(settings, EARLY, Date.parse('2026-09-30T18:00:00Z'))).toEqual({
      state: 'outside-schedule',
      until: Date.parse('2026-10-01T09:00:00Z'),
    });
  });

  it('schedule is ignored on the free plan after early access (focus stays on)', () => {
    const settings = settingsWith({ schedule: { enabled: true, days: [6], start: 0, end: 60, timeZone: 'UTC' } });
    expect(focusStatus(settings, FREE, NOW).state).toBe('on');
    expect(focusStatus(settings, PRO, NOW).state).toBe('outside-schedule');
  });
});

describe('computeFocus', () => {
  it('default: hides Shorts, home, Up next, end screens; calm home page', () => {
    const focus = computeFocus(DEFAULT_SETTINGS, EARLY, NOW, page('/'));
    expect(focus.hide).toEqual(['endscreen', 'home', 'related', 'shorts']);
    expect(focus.route).toBe('home');
    expect(focus.calm).toBe(true);
    expect(focus.redirect).toBeNull();
  });

  it('nothing is hidden while off, paused or outside the schedule', () => {
    for (const settings of [settingsWith({ enabled: false }), settingsWith({ pausedUntil: NOW + 1000 })]) {
      const focus = computeFocus(settings, EARLY, NOW, page('/'));
      expect(focus.hide).toEqual([]);
      expect(focus.calm).toBe(false);
      expect(focus.redirect).toBeNull();
    }
  });

  it('calm panel only on the home page', () => {
    expect(computeFocus(DEFAULT_SETTINGS, EARLY, NOW, page('/feed/subscriptions')).calm).toBe(false);
    expect(computeFocus(settingsWith({ hide: { ...DEFAULT_SETTINGS.hide, home: false } }), EARLY, NOW, page('/')).calm).toBe(false);
  });

  it('home → Subscriptions when chosen', () => {
    const focus = computeFocus(settingsWith({ homeMode: 'subscriptions' }), EARLY, NOW, page('/'));
    expect(focus.redirect).toBe(SUBSCRIPTIONS_PATH);
    expect(focus.calm).toBe(false);
    expect(computeFocus(settingsWith({ homeMode: 'subscriptions' }), EARLY, NOW, page('/watch?v=abcdefghijk')).redirect).toBeNull();
  });

  it('a Short opens as a normal video while Shorts are hidden', () => {
    expect(computeFocus(DEFAULT_SETTINGS, EARLY, NOW, page('/shorts/abcDEF12345')).redirect).toBe('/watch?v=abcDEF12345');
    const shown = settingsWith({ hide: { ...DEFAULT_SETTINGS.hide, shorts: false } });
    expect(computeFocus(shown, EARLY, NOW, page('/shorts/abcDEF12345')).redirect).toBeNull();
    expect(computeFocus(DEFAULT_SETTINGS, EARLY, NOW, page('/shorts/')).redirect).toBeNull();
  });

  it('allowlisted channel: comments, Up next and end screens come back on its videos only', () => {
    const settings = settingsWith({ hide: { ...DEFAULT_SETTINGS.hide, comments: true }, allowlist: [CALM] });
    const allowed = computeFocus(settings, EARLY, NOW, page('/watch?v=abcdefghijk', { id: null, handle: '@calmcoding' }));
    expect(allowed.channelAllowed).toBe(true);
    expect(allowed.hide).toEqual(['home', 'shorts']);
    const other = computeFocus(settings, EARLY, NOW, page('/watch?v=abcdefghijk', { id: null, handle: '@loud' }));
    expect(other.channelAllowed).toBe(false);
    expect(other.hide).toEqual(['comments', 'endscreen', 'home', 'related', 'shorts']);
    const unknown = computeFocus(settings, EARLY, NOW, page('/watch?v=abcdefghijk'));
    expect(unknown.hide).toContain('comments');
    // Only on watch pages.
    expect(computeFocus(settings, EARLY, NOW, page('/', { id: null, handle: '@calmcoding' })).channelAllowed).toBe(false);
    // Not on the free plan after early access.
    expect(computeFocus(settings, FREE, NOW, page('/watch?v=abcdefghijk', { id: null, handle: '@calmcoding' })).channelAllowed).toBe(false);
  });

  it('subscriptions-only: everything hidden, home and Explore go to Subscriptions, search stays', () => {
    const settings = settingsWith({ subscriptionsOnly: true, hide: { shorts: false, home: false, related: false, endscreen: false, comments: false } });
    const home = computeFocus(settings, EARLY, NOW, page('/'));
    expect(home.hide).toEqual(['comments', 'endscreen', 'explore', 'home', 'related', 'shorts']);
    expect(home.redirect).toBe(SUBSCRIPTIONS_PATH);
    expect(computeFocus(settings, EARLY, NOW, page('/feed/trending')).redirect).toBe(SUBSCRIPTIONS_PATH);
    expect(computeFocus(settings, EARLY, NOW, page('/results?search_query=x')).redirect).toBeNull();
    expect(computeFocus(settings, EARLY, NOW, page('/feed/subscriptions')).redirect).toBeNull();
    // Allowlisted channels keep comments and Up next even here.
    const allowed = settingsWith({ subscriptionsOnly: true, allowlist: [CALM] });
    expect(computeFocus(allowed, EARLY, NOW, page('/watch?v=abcdefghijk', { id: null, handle: '@calmcoding' })).hide).toEqual(['explore', 'home', 'shorts']);
    // Free plan after early access: the switch is ignored, the free switches apply.
    expect(computeFocus(settings, FREE, NOW, page('/')).hide).toEqual([]);
    expect(computeFocus(settings, FREE, NOW, page('/feed/trending')).redirect).toBeNull();
  });

  it('sameEffect compares what the page shows', () => {
    const a = computeFocus(DEFAULT_SETTINGS, EARLY, NOW, page('/'));
    expect(sameEffect(null, a)).toBe(false);
    expect(sameEffect(a, computeFocus(DEFAULT_SETTINGS, EARLY, NOW + 1000, page('/')))).toBe(true);
    expect(sameEffect(a, computeFocus(DEFAULT_SETTINGS, EARLY, NOW, page('/results')))).toBe(false);
    expect(sameEffect(a, computeFocus(settingsWith({ enabled: false }), EARLY, NOW, page('/')))).toBe(false);
  });
});
