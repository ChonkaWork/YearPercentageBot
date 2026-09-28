import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, countdownDecimals, decimalsFor, resolveHour12, sanitizeSettings, settingsEqual } from '../src/core/settings';
import { WIDGETS } from '../src/core/widgets';

describe('sanitizeSettings', () => {
  it('returns the defaults for missing or garbage input', () => {
    for (const raw of [undefined, null, 42, 'x', [], {}]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      weekStart: 'monday',
      widgets: { clock: true, year: true, month: true, week: true, day: true, countdowns: true, lifeWeeks: false },
      theme: 'auto',
      accent: 'mint',
      clock: 'auto',
      decimals: 'auto',
      life: { birthDate: null, years: 80 },
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
      widgets: { clock: true, year: false, month: true, week: true, day: true, countdowns: true, lifeWeeks: false },
      theme: 'auto',
      accent: 'pink',
      clock: '12h',
      decimals: 'auto',
      life: { birthDate: null, years: 80 },
    });
  });

  it('accepts decimals as numbers or numeric strings (select values)', () => {
    expect(sanitizeSettings({ decimals: 0 }).decimals).toBe(0);
    expect(sanitizeSettings({ decimals: '4' }).decimals).toBe(4);
    expect(sanitizeSettings({ decimals: 'auto' }).decimals).toBe('auto');
    expect(sanitizeSettings({ decimals: 2.5 }).decimals).toBe('auto');
    expect(sanitizeSettings({ decimals: '' }).decimals).toBe('auto');
  });

  it('keeps a Pro theme id (the plan decides what is shown)', () => {
    expect(sanitizeSettings({ theme: 'paper' }).theme).toBe('paper');
    expect(sanitizeSettings({ theme: 'contrast' }).theme).toBe('contrast');
  });

  it('sanitizes the life-in-weeks settings', () => {
    expect(sanitizeSettings({ life: { birthDate: '1990-05-01', years: 95 } }).life).toEqual({ birthDate: '1990-05-01', years: 95 });
    expect(sanitizeSettings({ life: { birthDate: '1990-02-30', years: 95.5 } }).life).toEqual({ birthDate: null, years: 80 });
    expect(sanitizeSettings({ life: 'x' }).life).toEqual({ birthDate: null, years: 80 });
  });

  it('shows new widgets with their default for existing users', () => {
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
