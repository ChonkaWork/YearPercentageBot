// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { EARLY_ACCESS, setEarlyAccessForTesting } from '../src/core/plan';
import { optionsForm } from '../src/ui/optionsForm';
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

describe('options form and the plan', () => {
  const initial = { name: 'Lamp', intervalMinutes: 60 as const, mode: 'text' as const, keyword: '', target: '' };
  const noop = { onAboutPro: () => undefined };

  afterEach(() => setEarlyAccessForTesting(EARLY_ACCESS));

  it('free: faster intervals and Pro rules are shown disabled with a PRO badge', () => {
    setEarlyAccessForTesting(false);
    let opened = 0;
    const form = optionsForm('t', initial, { plan: 'free', onAboutPro: () => opened++ });
    const options = Array.from(form.element.querySelectorAll('option'));
    expect(options.filter((option) => option.disabled).map((option) => option.textContent)).toEqual([
      '5 minutes · PRO',
      '15 minutes · PRO',
      '30 minutes · PRO',
    ]);
    const radios = Array.from(form.element.querySelectorAll<HTMLInputElement>('input[type=radio]'));
    expect(radios.map((radio) => [radio.value, radio.disabled])).toEqual([
      ['text', false],
      ['number', true],
      ['keyword', true],
      ['below', true],
    ]);
    expect(form.element.querySelectorAll('label .pro-badge')).toHaveLength(3);
    // Re-enabling after a save keeps locked choices locked.
    form.setDisabled(true);
    form.setDisabled(false);
    expect(radios.filter((radio) => radio.disabled).map((radio) => radio.value)).toEqual(['number', 'keyword', 'below']);
    const about = Array.from(form.element.querySelectorAll('button')).find((button) => button.textContent === 'About Pro')!;
    about.click();
    expect(opened).toBe(1);
  });

  it("free: a watch's current Pro settings stay selectable when editing", () => {
    setEarlyAccessForTesting(false);
    const form = optionsForm('t', { ...initial, intervalMinutes: 5, mode: 'keyword', keyword: 'Sold out' }, {
      plan: 'free',
      keep: { intervalMinutes: 5, mode: 'keyword' },
      ...noop,
    });
    const five = form.element.querySelector<HTMLOptionElement>('option[value="5"]')!;
    expect(five.disabled).toBe(false);
    expect(form.element.querySelector<HTMLInputElement>('input[value="keyword"]')!.disabled).toBe(false);
    expect(form.element.querySelector<HTMLInputElement>('input[value="number"]')!.disabled).toBe(true);
    expect(form.values()).toMatchObject({ intervalMinutes: 5, mode: 'keyword', keyword: 'Sold out' });
  });

  it('early access: everything is available, PRO badges still mark Pro rules', () => {
    setEarlyAccessForTesting(true);
    const form = optionsForm('t', initial, { plan: 'free', ...noop });
    expect(Array.from(form.element.querySelectorAll('option')).some((option) => option.disabled)).toBe(false);
    expect(Array.from(form.element.querySelectorAll<HTMLInputElement>('input[type=radio]')).some((radio) => radio.disabled)).toBe(false);
    expect(form.element.querySelectorAll('label .pro-badge')).toHaveLength(3);
    expect(form.element.querySelector('.pro-hint')).toBeNull();
  });

  it('asks for a valid target price in the price rule', () => {
    const form = optionsForm('t', { ...initial, mode: 'below' }, { plan: 'pro', ...noop });
    const target = form.element.querySelector<HTMLInputElement>('#t-target')!;
    expect(target.hidden).toBe(false);
    expect(form.validate()).toMatch(/price/);
    target.value = 'cheap';
    expect(form.validate()).toMatch(/price/);
    target.value = ' $100 ';
    expect(form.validate()).toBeNull();
    expect(form.values()).toMatchObject({ mode: 'below', target: '$100' });
  });
});
