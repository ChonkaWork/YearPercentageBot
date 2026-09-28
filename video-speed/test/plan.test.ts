import { describe, expect, it } from 'vitest';
import { EARLY_ACCESS, hasFeature, limitsFor, MAX_PRESETS, MAX_SITE_DEFAULTS, PRO_FEATURES, PRO_PRICE, sanitizePlan, type ProFeature } from '../src/core/plan';

const FEATURES: ProFeature[] = ['site-defaults', 'custom-presets'];

describe('plan', () => {
  it('is in early access at $1.99 until payments are configured', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$1.99');
  });

  it('sanitizes the stored plan (anything unknown is free)', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    expect(sanitizePlan('free')).toBe('free');
    for (const raw of [undefined, null, 'PRO', 'premium', 1, true, {}, ['pro']]) expect(sanitizePlan(raw)).toBe('free');
  });

  it('early access includes every feature, whatever the plan', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature)).toBe(true);
      expect(hasFeature('free', feature, true)).toBe(true);
    }
  });

  it('after early access: Pro features only on the Pro plan', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
    expect(hasFeature('pro', 'skip-silence' as ProFeature, false)).toBe(false);
  });

  it('limits follow the features', () => {
    expect(limitsFor('free', false)).toEqual({ maxSiteDefaults: 0, maxCustomPresets: 0 });
    expect(limitsFor('pro', false)).toEqual({ maxSiteDefaults: MAX_SITE_DEFAULTS, maxCustomPresets: MAX_PRESETS });
    expect(limitsFor('free')).toEqual(limitsFor('pro', false));
  });

  it('lists every Pro feature for the About Pro card', () => {
    expect(PRO_FEATURES.map((feature) => feature.id).sort()).toEqual([...FEATURES].sort());
    for (const feature of PRO_FEATURES) expect(feature.title && feature.text).toBeTruthy();
  });
});
