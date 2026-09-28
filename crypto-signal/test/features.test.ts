import { describe, expect, it } from 'vitest';
import {
  canUseCoin,
  canUseTimeframe,
  DEFAULT_ENTITLEMENTS,
  entitlementsFor,
  FEATURES,
  historyLimit,
  hasFeature,
  isProCoin,
  isProTimeframe,
  limitsFor,
  remainingAnalyses,
  requiredPlan,
} from '../src/core/features';

describe('feature gating', () => {
  it('the MVP ships as early access: Free plan, nothing enforced', () => {
    expect(DEFAULT_ENTITLEMENTS).toEqual({ plan: 'free', policy: 'early-access' });
    for (const feature of FEATURES) expect(hasFeature('free', feature)).toBe(true);
    expect(canUseCoin('DOGE', DEFAULT_ENTITLEMENTS)).toBe(true);
    expect(canUseTimeframe('1h', DEFAULT_ENTITLEMENTS)).toBe(true);
    expect(remainingAnalyses(500, DEFAULT_ENTITLEMENTS)).toBeNull();
    expect(historyLimit(50, DEFAULT_ENTITLEMENTS)).toBe(50);
    expect(limitsFor(DEFAULT_ENTITLEMENTS.plan, DEFAULT_ENTITLEMENTS.policy).coins).toBeNull();
  });

  it('an enforced Free plan has none of the Pro features', () => {
    for (const feature of FEATURES) {
      expect(hasFeature('free', feature, 'enforced')).toBe(false);
      expect(hasFeature('pro', feature, 'enforced')).toBe(true);
      expect(requiredPlan(feature)).toBe('pro');
    }
  });

  it('the Free preview limits coins, timeframes, daily analyses and history', () => {
    const free = entitlementsFor(true);
    expect(free).toEqual({ plan: 'free', policy: 'enforced' });
    expect(canUseCoin('BTC', free)).toBe(true);
    expect(canUseCoin('eth', free)).toBe(true);
    expect(canUseCoin('SOL', free)).toBe(false);
    expect(canUseTimeframe('4h', free)).toBe(true);
    expect(canUseTimeframe('1d', free)).toBe(false);
    expect(remainingAnalyses(0, free)).toBe(10);
    expect(remainingAnalyses(7, free)).toBe(3);
    expect(remainingAnalyses(12, free)).toBe(0);
    expect(historyLimit(20, free)).toBe(5);
    expect(historyLimit(0, free)).toBe(0);
    expect(entitlementsFor(false)).toEqual(DEFAULT_ENTITLEMENTS);
  });

  it('knows which coins and timeframes would carry a Pro badge', () => {
    expect(isProCoin('BTC')).toBe(false);
    expect(isProCoin('SOL')).toBe(true);
    expect(isProCoin('PEPE')).toBe(true);
    expect(isProTimeframe('4h')).toBe(false);
    expect(isProTimeframe('1h')).toBe(true);
  });
});
