import { describe, expect, it } from 'vitest';
import { MAX_COUNTDOWNS, addCountdown, CountdownLimitError, type Countdown } from '../src/core/countdown';
import {
  EARLY_ACCESS,
  FREE_MAX_COUNTDOWNS,
  PRO_FEATURES,
  PRO_MAX_COUNTDOWNS,
  PRO_MAX_GOALS,
  PRO_MAX_LINKS,
  PRO_PRICE,
  canAddCountdown,
  countdownLimitMessage,
  hasFeature,
  isEntitled,
  limitsFor,
  sanitizePlan,
  isUpgradable,
  limitMessage,
  listLimit,
  type ProFeature,
} from '../src/core/plan';
import { applyEntitlements, sanitizeSettings } from '../src/core/settings';
import { THEMES } from '../src/core/themes';
import { WIDGETS } from '../src/core/widgets';

const FEATURES: ProFeature[] = ['unlimited-goals', 'unlimited-countdowns', 'unlimited-links', 'theme-pack', 'life-in-weeks'];

function countdown(id: string): Countdown {
  return { id, name: id, date: '2026-12-24', time: null, createdAt: 1, showProgress: true, repeat: 'none' };
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
    expect(limitsFor('free')).toEqual({ maxCountdowns: PRO_MAX_COUNTDOWNS, maxGoals: PRO_MAX_GOALS, maxLinks: PRO_MAX_LINKS });
  });

  it('without early access: free gets the basics, pro gets everything', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
    expect(limitsFor('free', false)).toEqual({ maxCountdowns: 3, maxGoals: 1, maxLinks: 6 });
    expect(limitsFor('pro', false)).toEqual({ maxCountdowns: PRO_MAX_COUNTDOWNS, maxGoals: PRO_MAX_GOALS, maxLinks: PRO_MAX_LINKS });
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

describe('list limits', () => {
  it('free: 3 countdowns, 1 goal, 6 quick links; Pro lifts all three', () => {
    expect([listLimit('countdowns', 'free', false), listLimit('goals', 'free', false), listLimit('links', 'free', false)]).toEqual([3, 1, 6]);
    expect([listLimit('countdowns', 'pro', false), listLimit('goals', 'pro', false), listLimit('links', 'pro', false)]).toEqual([
      PRO_MAX_COUNTDOWNS,
      PRO_MAX_GOALS,
      PRO_MAX_LINKS,
    ]);
    expect(listLimit('goals', 'free')).toBe(PRO_MAX_GOALS);
    expect(isUpgradable('goals', 'free', false)).toBe(true);
    expect(isUpgradable('goals', 'pro', false)).toBe(false);
    expect(isUpgradable('links', 'free', true)).toBe(false);
    expect(limitMessage('countdowns', 'free', false)).toBe(countdownLimitMessage('free', false));
    expect(limitMessage('goals', 'pro', false)).toBe(`You can have up to ${PRO_MAX_GOALS} goals. Delete one to add another.`);
    expect(limitMessage('links', 'free', false)).toBe('Free keeps 6 quick links. Pro removes the limit.');
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

  it('goals and quick links are free widgets with a Pro limit', () => {
    const ids = WIDGETS.map((widget) => widget.id);
    expect(ids).toEqual(['clock', 'links', 'year', 'month', 'week', 'day', 'goals', 'countdowns', 'lifeWeeks']);
    for (const id of ['goals', 'links'] as const) expect(WIDGETS.find((widget) => widget.id === id)).toMatchObject({ tier: 'free', defaultVisible: true });
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
