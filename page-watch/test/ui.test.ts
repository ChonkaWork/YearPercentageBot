// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { icon, parseIcon } from '../src/ui/dom';
import { capitalize, intervalLabel, intervalPhrase, plural, relativeTime } from '../src/ui/format';
import { ICONS } from '../src/ui/icons';

describe('icons', () => {
  it('turns every bundled Bootstrap icon into shapes without parsing HTML', () => {
    for (const [name, source] of Object.entries(ICONS)) {
      const parsed = parseIcon(source);
      expect(parsed.viewBox, name).toBe('0 0 16 16');
      expect(parsed.shapes.length, name).toBeGreaterThan(0);
      expect(parsed.shapes.every((shape) => shape.attrs.some(([attr]) => attr === 'd')), name).toBe(true);
    }
  });

  it('builds decorative or labelled SVGs', () => {
    const decorative = icon(ICONS.bell);
    expect(decorative.getAttribute('aria-hidden')).toBe('true');
    expect(decorative.querySelectorAll('path').length).toBeGreaterThan(0);
    const labelled = icon(ICONS.warning, { label: 'Problem', size: 20 });
    expect(labelled.getAttribute('aria-label')).toBe('Problem');
    expect(labelled.getAttribute('width')).toBe('20');
  });

  it('drops anything that is not shape geometry', () => {
    const parsed = parseIcon('<svg viewBox="0 0 8 8"><path d="M0 0h8" onclick="alert(1)" style="x"/><script>alert(1)</script></svg>');
    expect(parsed).toEqual({ viewBox: '0 0 8 8', shapes: [{ tag: 'path', attrs: [['d', 'M0 0h8']] }] });
  });
});

describe('format', () => {
  it('pluralizes', () => {
    expect(plural(1, 'watch')).toBe('1 watch');
    expect(plural(2, 'watch')).toBe('2 watches');
    expect(plural(0, 'line')).toBe('0 lines');
    expect(capitalize('every hour')).toBe('Every hour');
  });

  it('describes intervals', () => {
    expect(intervalLabel(5)).toBe('5 min');
    expect(intervalLabel(360)).toBe('6 h');
    expect(intervalPhrase(15)).toBe('every 15 minutes');
    expect(intervalPhrase(60)).toBe('every hour');
    expect(intervalPhrase(360)).toBe('every 6 hours');
    expect(intervalPhrase(1440)).toBe('every day');
  });

  it('shows relative times', () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(relativeTime(now + 2 * 3_600_000, now)).toBe('in 2 hours');
    expect(relativeTime(now - 86_400_000, now)).toBe('yesterday');
  });
});
