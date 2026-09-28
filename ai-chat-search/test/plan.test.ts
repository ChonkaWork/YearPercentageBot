import { describe, expect, it } from 'vitest';
import { limitRefusal } from '../src/background/policy';
import {
  EARLY_ACCESS,
  FREE_MAX_CONVERSATIONS,
  hasFeature,
  isIndexFull,
  limitMessage,
  limitsFor,
  PRO_FEATURES,
  PRO_PRICE,
  sanitizePlan,
  type ProFeature,
} from '../src/core/plan';
import { planState } from '../src/storage/plan';

const FEATURES: ProFeature[] = ['unlimited-index', 'favourites', 'tags', 'export'];

describe('plan seam', () => {
  it('is in early access at $2.99 until payments are set up', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$2.99');
    expect(FREE_MAX_CONVERSATIONS).toBe(100);
  });

  it('sanitizes the stored plan, defaulting to free', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    expect(sanitizePlan('free')).toBe('free');
    for (const junk of [undefined, null, 'PRO', 'premium', 1, true, {}, ['pro']]) expect(sanitizePlan(junk)).toBe('free');
  });

  it('early access unlocks every feature for everyone', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature)).toBe(true);
      expect(hasFeature('free', feature, true)).toBe(true);
    }
    expect(limitsFor('free').maxConversations).toBe(Infinity);
  });

  it('after early access, Pro features need the pro plan', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
    expect(limitsFor('free', false)).toEqual({ maxConversations: 100 });
    expect(limitsFor('pro', false)).toEqual({ maxConversations: Infinity });
  });

  it('knows when the index is full', () => {
    const free = limitsFor('free', false);
    expect(isIndexFull(99, free)).toBe(false);
    expect(isIndexFull(100, free)).toBe(true);
    expect(isIndexFull(250, free)).toBe(true);
    expect(isIndexFull(1_000_000, limitsFor('pro', false))).toBe(false);
  });

  it('has a calm limit message and lists every Pro feature once', () => {
    expect(limitMessage(limitsFor('free', false))).toBe(
      "Free keeps 100 conversations. New ones aren't saved; everything already saved stays searchable. Pro removes the limit.",
    );
    expect(PRO_FEATURES.map((item) => item.feature).sort()).toEqual([...FEATURES].sort());
  });

  it('planState bundles features and limits', () => {
    const free = planState('free', false);
    expect(free.has('tags')).toBe(false);
    expect(free.limits.maxConversations).toBe(100);
    expect(planState('free', true).has('tags')).toBe(true);
    expect(planState('pro', false).has('export')).toBe(true);
  });
});

describe('free limit policy', () => {
  const free = limitsFor('free', false);

  it('refuses only new conversations once the free index is full', () => {
    expect(limitRefusal(true, 99, free)).toBeNull();
    expect(limitRefusal(true, 100, free)).toMatchObject({ ok: false, code: 'LIMIT' });
    // Saved conversations keep updating, even above the limit (e.g. after early access ends).
    expect(limitRefusal(false, 100, free)).toBeNull();
    expect(limitRefusal(false, 500, free)).toBeNull();
  });

  it('never refuses with Pro or during early access', () => {
    expect(limitRefusal(true, 10_000, limitsFor('pro', false))).toBeNull();
    expect(limitRefusal(true, 10_000, limitsFor('free', true))).toBeNull();
  });
});
