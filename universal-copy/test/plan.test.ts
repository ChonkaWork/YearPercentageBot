import { describe, expect, it } from 'vitest';
import { EARLY_ACCESS, hasFeature, limitsFor, PRO_FEATURES, PRO_PRICE, proMessage, sanitizePlan, type ProFeature } from '../src/core/plan';

const FEATURES: ProFeature[] = ['download', 'page-link', 'markdown-presets'];

describe('plan', () => {
  it('is in early access at $2.99 until payments are set up', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$2.99');
  });

  it('sanitizes the stored plan: only "pro" is Pro', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    for (const raw of ['free', 'PRO', ' pro', true, 1, null, undefined, {}, ['pro']]) expect(sanitizePlan(raw)).toBe('free');
  });

  it('early access unlocks every feature for everyone', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature)).toBe(true);
      expect(hasFeature('free', feature, true)).toBe(true);
    }
  });

  it('after early access, Pro features need the Pro plan', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
    expect(hasFeature('pro', 'unknown' as ProFeature, false)).toBe(false);
  });

  it('lists every Pro feature once, with a title and a description', () => {
    expect(PRO_FEATURES.map((feature) => feature.id).sort()).toEqual([...FEATURES].sort());
    for (const feature of PRO_FEATURES) expect(feature.title && feature.description).toBeTruthy();
  });

  it('has no count limits on either plan', () => {
    expect(limitsFor('free')).toEqual({});
    expect(limitsFor('pro')).toEqual({});
  });

  it('explains a Pro feature calmly, with the price', () => {
    expect(proMessage('download')).toBe('Download as file is part of Universal Copy Pro ($2.99 once). Everything else stays free.');
  });
});
