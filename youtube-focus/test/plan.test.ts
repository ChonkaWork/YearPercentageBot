import { describe, expect, it } from 'vitest';
import { EARLY_ACCESS, hasFeature, limitsFor, MAX_ALLOWLIST, PRO_FEATURES, PRO_PRICE, proMessage, sanitizePlan, type ProFeature } from '../src/core/plan';

const ALL: ProFeature[] = ['schedule', 'allowlist', 'subscriptions-only'];

describe('plan seam', () => {
  it('early access is on and the price is $1.99 (docs/MONETIZATION.md)', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$1.99');
    expect(PRO_FEATURES.map((feature) => feature.id)).toEqual(ALL);
  });

  it('sanitizes the stored plan', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    for (const raw of ['free', 'PRO', undefined, null, 1, { plan: 'pro' }]) expect(sanitizePlan(raw)).toBe('free');
  });

  it('early access includes everything, for both plans', () => {
    for (const feature of ALL) {
      expect(hasFeature('free', feature)).toBe(true);
      expect(hasFeature('free', feature, true)).toBe(true);
    }
    expect(limitsFor('free')).toEqual({ maxAllowedChannels: MAX_ALLOWLIST });
  });

  it('after early access: free has none, pro has all', () => {
    for (const feature of ALL) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
    expect(limitsFor('free', false)).toEqual({ maxAllowedChannels: 0 });
    expect(limitsFor('pro', false)).toEqual({ maxAllowedChannels: MAX_ALLOWLIST });
  });

  it('explains calmly', () => {
    expect(proMessage('schedule')).toBe('Focus schedule is part of YouTube Focus Pro ($1.99 once). Your settings are kept.');
  });
});
