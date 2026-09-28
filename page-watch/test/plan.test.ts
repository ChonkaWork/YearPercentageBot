import { afterEach, describe, expect, it } from 'vitest';
import {
  allowedInterval,
  canAddWatch,
  EARLY_ACCESS,
  FREE_MAX_WATCHES,
  hasFeature,
  INTERVAL_MESSAGE,
  isIntervalAllowed,
  isRuleAllowed,
  limitsFor,
  planProblem,
  PRO_FEATURES,
  PRO_PRICE,
  RULE_MESSAGE,
  ruleFeature,
  sanitizePlan,
  setEarlyAccessForTesting,
} from '../src/core/plan';
import { INTERVALS } from '../src/core/types';

afterEach(() => setEarlyAccessForTesting(EARLY_ACCESS));

describe('plan seam', () => {
  it('ships in early access at the agreed price', () => {
    expect(EARLY_ACCESS).toBe(true);
    expect(PRO_PRICE).toBe('$3.99');
  });

  it('sanitizes the stored plan (default free)', () => {
    expect(sanitizePlan('pro')).toBe('pro');
    expect(sanitizePlan('free')).toBe('free');
    for (const junk of [undefined, null, 'PRO', 1, {}, ['pro']]) expect(sanitizePlan(junk)).toBe('free');
  });

  it('early access turns every Pro feature on, even on the free plan', () => {
    setEarlyAccessForTesting(true);
    for (const feature of PRO_FEATURES) expect(hasFeature('free', feature)).toBe(true);
    expect(limitsFor('free')).toEqual({ maxWatches: Number.POSITIVE_INFINITY, minIntervalMinutes: 5 });
  });

  it('free: 3 watches, intervals from an hour, only "any change"', () => {
    setEarlyAccessForTesting(false);
    for (const feature of PRO_FEATURES) expect(hasFeature('free', feature)).toBe(false);
    expect(limitsFor('free')).toEqual({ maxWatches: FREE_MAX_WATCHES, minIntervalMinutes: 60 });
    expect(canAddWatch('free', 2)).toBe(true);
    expect(canAddWatch('free', 3)).toBe(false);
    expect(canAddWatch('free', 7)).toBe(false);
    expect(INTERVALS.filter((minutes) => isIntervalAllowed('free', minutes))).toEqual([60, 360, 1440]);
    expect(isRuleAllowed('free', 'text')).toBe(true);
    expect(isRuleAllowed('free', 'number')).toBe(false);
    expect(isRuleAllowed('free', 'keyword')).toBe(false);
    expect(isRuleAllowed('free', 'below')).toBe(false);
  });

  it('pro: unlimited watches, intervals from 5 minutes, every rule', () => {
    setEarlyAccessForTesting(false);
    for (const feature of PRO_FEATURES) expect(hasFeature('pro', feature)).toBe(true);
    expect(canAddWatch('pro', 1000)).toBe(true);
    expect(INTERVALS.every((minutes) => isIntervalAllowed('pro', minutes))).toBe(true);
    expect(['text', 'number', 'keyword', 'below'].every((mode) => isRuleAllowed('pro', mode as never))).toBe(true);
  });

  it('maps rules to features', () => {
    expect(ruleFeature('text')).toBeNull();
    expect(ruleFeature('number')).toBe('number-rule');
    expect(ruleFeature('keyword')).toBe('keyword-rule');
    expect(ruleFeature('below')).toBe('price-rule');
  });

  it('clamps intervals to what the plan allows', () => {
    setEarlyAccessForTesting(false);
    expect(allowedInterval('free', 15, 60)).toBe(60);
    expect(allowedInterval('free', 360, 60)).toBe(360);
    expect(allowedInterval('pro', 5, 60)).toBe(5);
  });

  it('explains what needs Pro, but keeps a watch\'s current settings allowed', () => {
    setEarlyAccessForTesting(false);
    expect(planProblem('free', { mode: 'text', intervalMinutes: 60 })).toBeNull();
    expect(planProblem('free', { mode: 'keyword', intervalMinutes: 60 })).toBe(RULE_MESSAGE);
    expect(planProblem('free', { mode: 'text', intervalMinutes: 15 })).toBe(INTERVAL_MESSAGE);
    const keep = { mode: 'keyword' as const, intervalMinutes: 5 };
    expect(planProblem('free', { mode: 'keyword', intervalMinutes: 5 }, keep)).toBeNull();
    expect(planProblem('free', { intervalMinutes: 5 }, keep)).toBeNull();
    expect(planProblem('free', { mode: 'number' }, keep)).toBe(RULE_MESSAGE);
    expect(planProblem('free', { intervalMinutes: 15 }, keep)).toBe(INTERVAL_MESSAGE);
    expect(planProblem('pro', { mode: 'below', intervalMinutes: 5 })).toBeNull();
  });
});
