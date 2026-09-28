import { describe, expect, it } from 'vitest';
import { alertLimit, can, entitlementsFor, watchlistLimit } from '../src/core/features';
import {
  EARLY_ACCESS,
  hasFeature,
  limitsFor,
  planLimits,
  PRO_FEATURES,
  PRO_HIGHLIGHTS,
  PRO_PRICE,
  resolveEntitlements,
  sanitizePlan,
} from '../src/core/plan';

describe('plan seam', () => {
  it('ships in early access at $2.99', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$2.99');
  });

  it('sanitizes the stored plan to Free by default', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    expect(sanitizePlan('free')).toBe('free');
    for (const junk of [undefined, null, 'PRO', 1, {}, ['pro']]) expect(sanitizePlan(junk)).toBe('free');
  });

  it('early access unlocks every feature for Free; enforced Free has none', () => {
    for (const feature of PRO_FEATURES) {
      expect(hasFeature('free', feature)).toBe(true);
      expect(hasFeature('free', feature, 'enforced')).toBe(false);
      expect(hasFeature('pro', feature, 'enforced')).toBe(true);
    }
    expect(limitsFor('free')).toEqual(planLimits('pro'));
    expect(limitsFor('free', 'enforced')).toEqual({ coins: ['BTC', 'ETH'], dailyAnalyses: 10, timeframes: ['4h'], historyItems: 5, alerts: 0, watchlist: 0 });
  });

  it('resolves entitlements from the stored plan, early access and the Free preview', () => {
    expect(resolveEntitlements('free', false)).toEqual({ plan: 'free', policy: 'early-access' });
    expect(resolveEntitlements('pro', true)).toEqual({ plan: 'free', policy: 'enforced' });
    expect(resolveEntitlements('pro', false, false)).toEqual({ plan: 'pro', policy: 'enforced' });
    expect(resolveEntitlements('free', false, false)).toEqual({ plan: 'free', policy: 'enforced' });
  });

  it('alert and watchlist limits follow the plan', () => {
    expect(alertLimit(entitlementsFor(false))).toBe(10);
    expect(watchlistLimit(entitlementsFor(false))).toBe(8);
    expect(alertLimit(entitlementsFor(true, 'pro'))).toBe(0);
    expect(watchlistLimit(entitlementsFor(true))).toBe(0);
    expect(can('alerts', resolveEntitlements('pro', false, false))).toBe(true);
    expect(can('alerts', resolveEntitlements('free', false, false))).toBe(false);
  });

  it('the About Pro card lists every Pro feature once', () => {
    expect(PRO_HIGHLIGHTS.map((item) => item.feature).sort()).toEqual([...PRO_FEATURES].sort());
  });
});
