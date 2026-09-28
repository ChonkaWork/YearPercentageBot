import { describe, expect, it } from 'vitest';
import { MAX_COUNTDOWNS, addCountdown, CountdownLimitError, type Countdown } from '../src/core/countdown';
import {
  EARLY_ACCESS,
  FREE_MAX_COUNTDOWNS,
  PRO_FEATURES,
  PRO_MAX_COUNTDOWNS,
  PRO_PRICE,
  canAddCountdown,
  countdownLimitMessage,
  hasFeature,
  isEntitled,
  limitsFor,
  sanitizePlan,
  type ProFeature,
} from '../src/core/plan';
import { applyEntitlements, sanitizeSettings } from '../src/core/settings';
import { THEMES } from '../src/core/themes';
import { WIDGETS } from '../src/core/widgets';

const FEATURES: ProFeature[] = ['unlimited-countdowns', 'theme-pack', 'life-in-weeks'];

function countdown(id: string): Countdown {
  return { id, name: id, date: '2026-12-24', time: null, createdAt: 1, showProgress: true };
}

describe('plan seam', () => {
  it('is in early access until payments exist, at the agreed price', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$1.99');
    expect(PRO_FEATURES.map((feature) => feature.id)).toEqual(FEATURES);
  });

  it('sanitizes the stored plan (default free)', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    for (const raw of [undefined, null, 'free', 'PRO', 1, {}, ['pro'], 'premium']) expect(sanitizePlan(raw)).toBe('free');
  });

  it('early access unlocks every feature for everyone', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature)).toBe(true);
      expect(hasFeature('free', feature, true)).toBe(true);
    }
    expect(limitsFor('free')).toEqual({ maxCountdowns: PRO_MAX_COUNTDOWNS });
  });

  it('without early access: free gets the basics, pro gets everything', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
    expect(limitsFor('free', false)).toEqual({ maxCountdowns: 3 });
    expect(limitsFor('pro', false)).toEqual({ maxCountdowns: PRO_MAX_COUNTDOWNS });
  });

  it('keeps the Pro cap in sync with the countdown model', () => {
    expect(PRO_MAX_COUNTDOWNS).toBe(MAX_COUNTDOWNS);
    expect(FREE_MAX_COUNTDOWNS).toBe(3);
  });

  it('only blocks adding, never what already exists', () => {
    expect(canAddCountdown(2, 'free', false)).toBe(true);
    expect(canAddCountdown(3, 'free', false)).toBe(false);
    expect(canAddCountdown(7, 'free', false)).toBe(false);
    expect(canAddCountdown(7, 'pro', false)).toBe(true);
    expect(canAddCountdown(PRO_MAX_COUNTDOWNS, 'pro', false)).toBe(false);

    const five = ['a', 'b', 'c', 'd', 'e'].map(countdown);
    const max = limitsFor('free', false).maxCountdowns;
    const message = countdownLimitMessage('free', false);
    expect(message).toBe('Free keeps 3 countdowns. Pro removes the limit.');
    expect(() => addCountdown(five, countdown('f'), max, message)).toThrow(new CountdownLimitError(message));
    expect(() => addCountdown(five.slice(0, 2), countdown('f'), max, message)).not.toThrow();
    // Undo after a delete restores without a plan limit.
    expect(addCountdown(five.slice(0, 4), five[4]!)).toHaveLength(5);
    expect(countdownLimitMessage('pro', false)).toBe(`You can have up to ${PRO_MAX_COUNTDOWNS} countdowns. Delete one to add another.`);
  });

  it('decides registry entries by tier', () => {
    const paper = THEMES.find((theme) => theme.id === 'paper')!;
    const light = THEMES.find((theme) => theme.id === 'light')!;
    expect(isEntitled(light, 'free', false)).toBe(true);
    expect(isEntitled(paper, 'free', false)).toBe(false);
    expect(isEntitled(paper, 'pro', false)).toBe(true);
    expect(isEntitled(paper, 'free', true)).toBe(true);
  });
});

describe('free vs pro in the registries', () => {
  it('free has two themes (light and dark, plus auto between them); pro adds a pack of at least 4', () => {
    const free = THEMES.filter((theme) => theme.tier === 'free').map((theme) => theme.id);
    expect(free).toEqual(['auto', 'light', 'dark']);
    const pro = THEMES.filter((theme) => theme.tier === 'pro');
    expect(pro.length).toBeGreaterThanOrEqual(4);
    for (const theme of pro) expect(theme.feature).toBe('theme-pack');
  });

  it('life in weeks is the only Pro widget, off by default', () => {
    const pro = WIDGETS.filter((widget) => widget.tier === 'pro');
    expect(pro).toEqual([{ id: 'lifeWeeks', label: 'Life in weeks', tier: 'pro', feature: 'life-in-weeks', defaultVisible: false }]);
  });
});

describe('applyEntitlements', () => {
  const chosen = sanitizeSettings({ theme: 'paper', accent: 'blue', widgets: { lifeWeeks: true, year: false }, life: { birthDate: '1990-05-01', years: 90 } });

  it('shows Pro choices while the plan includes them', () => {
    expect(applyEntitlements(chosen, 'free', true)).toEqual(chosen);
    expect(applyEntitlements(chosen, 'pro', false)).toEqual(chosen);
  });

  it('falls back to free defaults otherwise, without touching the stored settings', () => {
    const shown = applyEntitlements(chosen, 'free', false);
    expect(shown.theme).toBe('auto');
    expect(shown.accent).toBe('blue');
    expect(shown.widgets.lifeWeeks).toBe(false);
    expect(shown.widgets.year).toBe(false);
    expect(shown.life).toEqual({ birthDate: '1990-05-01', years: 90 });
    expect(chosen.theme).toBe('paper');
    expect(chosen.widgets.lifeWeeks).toBe(true);
  });
});
