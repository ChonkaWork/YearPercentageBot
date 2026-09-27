import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, countdownDecimals, decimalsFor, resolveHour12, sanitizeSettings, settingsEqual } from '../src/core/settings';
import { WIDGETS } from '../src/core/widgets';

describe('sanitizeSettings', () => {
  it('returns the defaults for missing or garbage input', () => {
    for (const raw of [undefined, null, 42, 'x', [], {}]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      weekStart: 'monday',
      widgets: { clock: true, year: true, month: true, week: true, day: true, countdowns: true },
      theme: 'auto',
      accent: 'mint',
      clock: 'auto',
      decimals: 'auto',
    });
  });

  it('keeps valid fields and replaces invalid ones one by one', () => {
    expect(
      sanitizeSettings({
        weekStart: 'sunday',
        widgets: { year: false, week: 'no', unknown: false },
        theme: 'neon',
        accent: 'pink',
        clock: '12h',
        decimals: 9,
        extra: true,
      }),
    ).toEqual({
      weekStart: 'sunday',
      widgets: { clock: true, year: false, month: true, week: true, day: true, countdowns: true },
      theme: 'auto',
      accent: 'pink',
      clock: '12h',
      decimals: 'auto',
    });
  });

  it('accepts decimals as numbers or numeric strings (select values)', () => {
    expect(sanitizeSettings({ decimals: 0 }).decimals).toBe(0);
    expect(sanitizeSettings({ decimals: '4' }).decimals).toBe(4);
    expect(sanitizeSettings({ decimals: 'auto' }).decimals).toBe('auto');
    expect(sanitizeSettings({ decimals: 2.5 }).decimals).toBe('auto');
    expect(sanitizeSettings({ decimals: '' }).decimals).toBe('auto');
  });

  it('shows new widgets by default for existing users', () => {
    const stored = { widgets: { year: false } };
    expect(Object.keys(sanitizeSettings(stored).widgets)).toEqual(WIDGETS.map((widget) => widget.id));
  });

  it('never shares the frozen default object', () => {
    const settings = sanitizeSettings(undefined);
    settings.widgets.year = false;
    expect(DEFAULT_SETTINGS.widgets.year).toBe(true);
  });
});

describe('derived values', () => {
  it('picks decimals per period', () => {
    expect(decimalsFor('year', 'auto')).toBe(2);
    expect(decimalsFor('day', 'auto')).toBe(1);
    expect(decimalsFor('year', 0)).toBe(0);
    expect(decimalsFor('week', 4)).toBe(4);
    expect(countdownDecimals('auto')).toBe(1);
    expect(countdownDecimals(3)).toBe(3);
  });

  it('resolves the clock format', () => {
    expect(resolveHour12('auto', true)).toBe(true);
    expect(resolveHour12('auto', false)).toBe(false);
    expect(resolveHour12('12h', false)).toBe(true);
    expect(resolveHour12('24h', true)).toBe(false);
  });

  it('compares settings by value', () => {
    expect(settingsEqual(sanitizeSettings({}), sanitizeSettings({ theme: 'auto' }))).toBe(true);
    expect(settingsEqual(sanitizeSettings({}), sanitizeSettings({ theme: 'dark' }))).toBe(false);
  });
});
