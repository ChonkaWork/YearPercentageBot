import { describe, expect, it } from 'vitest';
import { EARLY_ACCESS, hasFeature, limitsFor, PRO_FEATURES, PRO_PRICE, sanitizePlan } from '../src/core/plan';

describe('plan', () => {
  it('is in early access at $1.99 until payments exist', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$1.99');
    expect(PRO_FEATURES.map((feature) => feature.id)).toEqual(['auto-clean', 'custom-rules']);
  });

  it('gives everything to everyone during early access', () => {
    expect(hasFeature('free', 'auto-clean')).toBe(true);
    expect(hasFeature('free', 'custom-rules')).toBe(true);
  });

  it('gates Pro features once early access ends', () => {
    expect(hasFeature('free', 'auto-clean', false)).toBe(false);
    expect(hasFeature('free', 'custom-rules', false)).toBe(false);
    expect(hasFeature('pro', 'auto-clean', false)).toBe(true);
    expect(limitsFor('free', false)).toEqual({ maxSites: 0, maxRules: 0 });
    expect(limitsFor('pro', false)).toEqual({ maxSites: 100, maxRules: 50 });
  });

  it('sanitizes the stored plan', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    for (const value of [undefined, null, 'PRO', 1, {}]) expect(sanitizePlan(value)).toBe('free');
  });
});
