import { describe, expect, it } from 'vitest';
import {
  EARLY_ACCESS,
  FREE_HISTORY_LIMIT,
  MAX_TEMPLATES,
  PRO_FEATURES,
  PRO_HISTORY_LIMIT,
  PRO_PRICE,
  hasFeature,
  historyCap,
  isHistoryAtFreeLimit,
  limitMessage,
  limitsFor,
  sanitizePlan,
  type ProFeature,
} from '../src/core/plan';

const FEATURES: ProFeature[] = ['templates', 'template-variables', 'template-sharing', 'long-history', 'history-search', 'pinned-history'];

describe('plan seam', () => {
  it('is in early access at $2.99 until payments are configured', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$2.99');
  });

  it('sanitizes the stored plan to free', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    expect(sanitizePlan('free')).toBe('free');
    for (const raw of [undefined, null, 'PRO', 'premium', 1, true, {}, ['pro']]) expect(sanitizePlan(raw)).toBe('free');
  });

  it('early access unlocks every feature, even on the free plan', () => {
    for (const feature of FEATURES) expect(hasFeature('free', feature, true)).toBe(true);
    expect(limitsFor('free', true)).toEqual({ maxHistoryItems: PRO_HISTORY_LIMIT, maxTemplates: MAX_TEMPLATES });
    // Default argument is the real flag.
    expect(hasFeature('free', 'templates')).toBe(EARLY_ACCESS);
  });

  it('after launch, only Pro gets Pro features and limits', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature, false)).toBe(false);
      expect(hasFeature('pro', feature, false)).toBe(true);
    }
    expect(limitsFor('free', false)).toEqual({ maxHistoryItems: FREE_HISTORY_LIMIT, maxTemplates: 0 });
    expect(limitsFor('pro', false)).toEqual({ maxHistoryItems: 500, maxTemplates: MAX_TEMPLATES });
    expect(FREE_HISTORY_LIMIT).toBe(20);
  });

  it('lists every Pro feature for the About Pro card', () => {
    expect(PRO_FEATURES.map((item) => item.feature).sort()).toEqual([...FEATURES].sort());
    for (const item of PRO_FEATURES) expect(item.title && item.description).toBeTruthy();
  });

  it('the user setting lowers history, the plan caps it', () => {
    const free = limitsFor('free', false);
    const pro = limitsFor('pro', false);
    expect(historyCap(10, free, 0)).toBe(10);
    expect(historyCap(0, free, 5)).toBe(0);
    expect(historyCap(300, pro, 0)).toBe(300);
    expect(historyCap(300, free, 3)).toBe(FREE_HISTORY_LIMIT);
  });

  it('never deletes saved prompts when the plan shrinks (history rotates at its size)', () => {
    const free = limitsFor('free', false);
    expect(historyCap(500, free, 180)).toBe(180);
    expect(historyCap(50, free, 180)).toBe(50);
    expect(historyCap(500, free, 20)).toBe(FREE_HISTORY_LIMIT);
  });

  it('knows when a free history is full', () => {
    expect(isHistoryAtFreeLimit(20, limitsFor('free', false))).toBe(true);
    expect(isHistoryAtFreeLimit(19, limitsFor('free', false))).toBe(false);
    expect(isHistoryAtFreeLimit(500, limitsFor('pro', false))).toBe(false);
    expect(isHistoryAtFreeLimit(20, limitsFor('free', true))).toBe(false);
  });

  it('limit messages are calm and short', () => {
    expect(limitMessage('history')).toBe('Free keeps the last 20 prompts. Pro keeps up to 500, with search and pins.');
    for (const topic of ['history', 'templates', 'history-search', 'pinned-history', 'template-variables', 'template-sharing'] as const) {
      const message = limitMessage(topic);
      expect(message.length).toBeLessThan(120);
      expect(message).not.toMatch(/!|upgrade now|limited time|hurry/i);
    }
    expect(limitMessage('templates')).toMatch(/kept/);
  });
});
