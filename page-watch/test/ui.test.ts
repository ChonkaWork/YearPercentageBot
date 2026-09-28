// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { EARLY_ACCESS, setEarlyAccessForTesting } from '../src/core/plan';
import { optionsForm } from '../src/ui/optionsForm';
import { icon, parseIcon } from '../src/ui/dom';
import { capitalize, intervalLabel, intervalPhrase, plural, relativeTime } from '../src/ui/format';
import { ICONS } from '../src/ui/icons';
import type { Change, DiffLine } from '../src/core/types';

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
    expect(plural(3, 'entry')).toBe('3 entries');
    expect(plural(2, 'day')).toBe('2 days');
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
      '1 minute · PRO',
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
      ['lowest', true],
    ]);
    expect(form.element.querySelectorAll('label .pro-badge')).toHaveLength(4);
    // Re-enabling after a save keeps locked choices locked.
    form.setDisabled(true);
    form.setDisabled(false);
    expect(radios.filter((radio) => radio.disabled).map((radio) => radio.value)).toEqual(['number', 'keyword', 'below', 'lowest']);
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
    expect(form.element.querySelectorAll('label .pro-badge')).toHaveLength(4);
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

describe('diff view', () => {
  const change = (lines: DiffLine[], summary = 'x'): Change => ({ id: 'c', at: 0, summary, added: 1, removed: 1, lines, truncated: false, seen: false });

  it('shows a short region as large before → after words', async () => {
    const { diffView } = await import('../src/popup/diff');
    const view = diffView(change([{ type: 'remove', text: 'Out of stock' }, { type: 'add', text: 'In stock' }]));
    expect(view.querySelector('.diff-lines')).toBeNull();
    expect(view.querySelector('.diff-words del')?.textContent).toBe('Out of');
    expect(view.querySelector('.diff-words ins')?.textContent).toBe('In');
    expect(view.querySelector('.diff-counts')).toBeNull();
  });

  it('greys ignored lines and offers to watch them again', async () => {
    const { diffView } = await import('../src/popup/diff');
    const lines: DiffLine[] = [
      { type: 'context', text: 'Title' },
      { type: 'remove', text: '$129.00' },
      { type: 'add', text: '$99.00' },
      { type: 'remove', text: '12 people are viewing', ignored: 'v1' },
      { type: 'add', text: '15 people are viewing', ignored: 'v1' },
      { type: 'remove', text: 'Oak Side Table', ignored: 'gone' },
    ];
    const unignored: string[] = [];
    const view = diffView(change(lines), { activeRules: new Map([['v1', 'segment']]), onUnignore: (id) => unignored.push(id) });
    expect(view.querySelectorAll('.diff-ignored')).toHaveLength(3);
    const notes = Array.from(view.querySelectorAll('.diff-note'));
    expect(notes.map((note) => note.textContent)).toEqual(['Ignored: changes on every checkWatch this line again', 'Ignored: changes on every checkWatched again']);
    notes[0]!.querySelector('button')!.click();
    expect(unignored).toEqual(['v1']);
    // Screen readers hear that a line was ignored.
    expect(view.querySelector('.diff-ignored .visually-hidden')?.textContent).toBe('Ignored, removed: ');
  });
});

describe('charts', () => {
  const points = [
    { t: 0, v: 129, r: '$129.00' },
    { t: 86_400_000, v: 99, r: '$99.00' },
    { t: 2 * 86_400_000, v: 109, r: '$109.00' },
  ];

  it('draws a labelled sparkline', async () => {
    const { sparkline } = await import('../src/ui/chart');
    const svg = sparkline(points, 'Price: $129.00 to $109.00');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Price: $129.00 to $109.00');
    expect(svg.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    expect(svg.querySelectorAll('circle')).toHaveLength(1);
  });

  it('labels the high and low, and reads points with the keyboard', async () => {
    const { historyChart } = await import('../src/ui/chart');
    const chart = historyChart(points, { noun: 'Price', now: 2 * 86_400_000 });
    const texts = Array.from(chart.querySelectorAll('text')).map((text) => text.textContent);
    expect(texts).toContain('High $129.00');
    expect(texts).toContain('Low $99.00');
    const svg = chart.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toMatch(/lowest \$99\.00, highest \$129\.00, now \$109\.00/);
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    const tip = chart.querySelector<HTMLElement>('.history-tip')!;
    expect(tip.hidden).toBe(false);
    expect(tip.querySelector('strong')?.textContent).toBe('$129.00');
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(tip.querySelector('strong')?.textContent).toBe('$99.00');
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tip.hidden).toBe(true);
  });
});
