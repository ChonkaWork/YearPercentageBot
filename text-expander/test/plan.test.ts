import { describe, expect, it } from 'vitest';
import {
  canAddSnippets,
  defaultPlanState,
  EARLY_ACCESS,
  FREE_SNIPPET_LIMIT,
  freeLimitMessage,
  hasFeature,
  isFreeLimit,
  limitsFor,
  planLabel,
  PRO_FEATURES,
  PRO_PRICE,
  sanitizePlan,
  type ProFeature,
} from '../src/core/plan';
import { LIMITS } from '../src/core/snippets';

const FEATURES: ProFeature[] = ['unlimited-snippets', 'tags', 'fill-in-fields'];

describe('plan', () => {
  it('is in early access until payments are configured, at the agreed price', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$3.99');
    expect(FREE_SNIPPET_LIMIT).toBe(20);
    expect(defaultPlanState()).toEqual({ plan: 'free', earlyAccess: true });
  });

  it('sanitizes the stored plan: anything but "pro" is free', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    for (const raw of ['free', 'PRO', 'premium', undefined, null, 1, {}, ['pro']]) expect(sanitizePlan(raw)).toBe('free');
  });

  it('early access unlocks every feature, whatever the stored plan', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature)).toBe(true);
      expect(hasFeature('free', feature, true)).toBe(true);
    }
    expect(limitsFor('free')).toEqual({ maxSnippets: LIMITS.snippetsMax });
  });

  it('without early access, free gets 20 snippets and no Pro features; Pro gets everything', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
    expect(limitsFor('free', false)).toEqual({ maxSnippets: 20 });
    expect(limitsFor('pro', false)).toEqual({ maxSnippets: LIMITS.snippetsMax });
  });

  it('checks whether more snippets fit, never counting existing ones against the user', () => {
    const free = { plan: 'free' as const, earlyAccess: false };
    expect(canAddSnippets(free, 19)).toBe(true);
    expect(canAddSnippets(free, 20)).toBe(false);
    expect(canAddSnippets(free, 35)).toBe(false);
    expect(canAddSnippets(free, 15, 5)).toBe(true);
    expect(canAddSnippets(free, 15, 6)).toBe(false);
    expect(canAddSnippets({ plan: 'pro', earlyAccess: false }, 500)).toBe(true);
    expect(canAddSnippets({ plan: 'pro', earlyAccess: false }, LIMITS.snippetsMax)).toBe(false);
    expect(isFreeLimit(free)).toBe(true);
    expect(isFreeLimit({ plan: 'free', earlyAccess: true })).toBe(false);
  });

  it('has a calm limit message and labels for the About Pro card', () => {
    expect(freeLimitMessage()).toBe('Free keeps 20 snippets. Pro removes the limit.');
    expect(planLabel({ plan: 'free', earlyAccess: true })).toBe('Early access');
    expect(planLabel({ plan: 'free', earlyAccess: false })).toBe('Free');
    expect(planLabel({ plan: 'pro', earlyAccess: true })).toBe('Pro');
    expect(PRO_FEATURES.map((info) => info.feature)).toEqual(FEATURES);
  });
});
