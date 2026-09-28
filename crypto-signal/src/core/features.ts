import {
  DEFAULT_POLICY,
  hasFeature,
  limitsFor,
  planLimits,
  PRO_FEATURES,
  resolveEntitlements,
  type Entitlements,
  type Plan,
  type ProFeature,
} from './plan';
import type { Interval } from './types';

/**
 * CryptoSignal's gating helpers, built on the plan seam in `plan.ts` (EARLY_ACCESS, PRO_PRICE,
 * hasFeature, limitsFor). Everything here answers "may the user do X right now?" for a given
 * `Entitlements` (stored plan + policy), so the popup and the service worker never test the
 * plan themselves.
 *
 * While EARLY_ACCESS is true every feature is unlocked for everyone and small PRO badges mark
 * what a paid plan covers. Settings has a "Preview Free plan limits" switch that enforces the
 * Free column, so the gated experience can be tried and tested without any billing code.
 */

export {
  DEFAULT_POLICY,
  EARLY_ACCESS,
  hasFeature,
  limitsFor,
  planLimits,
  PRO_FEATURES,
  PRO_HIGHLIGHTS,
  PRO_PRICE,
  requiredPlan,
  resolveEntitlements,
  sanitizePlan,
} from './plan';
export type { Entitlements, GatingPolicy, Plan, PlanLimits, ProFeature } from './plan';

/** @deprecated Kept for older imports; use ProFeature. */
export type Feature = ProFeature;
/** @deprecated Kept for older imports; use PRO_FEATURES. */
export const FEATURES = PRO_FEATURES;

/** Nothing stored and no preview: Free plan under the default policy (early access today). */
export const DEFAULT_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({ plan: 'free', policy: DEFAULT_POLICY });

/** Entitlements from the stored plan and the "Preview Free plan limits" switch. */
export function entitlementsFor(previewFreePlan: boolean, storedPlan: Plan = 'free'): Entitlements {
  return resolveEntitlements(storedPlan, previewFreePlan);
}

export function can(feature: ProFeature, entitlements: Entitlements): boolean {
  return hasFeature(entitlements.plan, feature, entitlements.policy);
}

export function canUseCoin(symbol: string, entitlements: Entitlements): boolean {
  if (can('allCoins', entitlements)) return true;
  return limitsFor(entitlements.plan, entitlements.policy).coins?.includes(symbol.toUpperCase()) ?? true;
}

export function canUseTimeframe(interval: Interval, entitlements: Entitlements): boolean {
  if (can('allTimeframes', entitlements)) return true;
  return limitsFor(entitlements.plan, entitlements.policy).timeframes.includes(interval);
}

/** Would this coin / timeframe be Pro-only under an enforced Free plan? (For badges.) */
export function isProCoin(symbol: string): boolean {
  return !(planLimits('free').coins?.includes(symbol.toUpperCase()) ?? true);
}

export function isProTimeframe(interval: Interval): boolean {
  return !planLimits('free').timeframes.includes(interval);
}

/** Remaining fresh analyses today, or null when unlimited. */
export function remainingAnalyses(usedToday: number, entitlements: Entitlements): number | null {
  if (can('unlimitedAnalyses', entitlements)) return null;
  const limit = limitsFor(entitlements.plan, entitlements.policy).dailyAnalyses;
  return limit === null ? null : Math.max(0, limit - Math.max(0, usedToday));
}

export function historyLimit(requested: number, entitlements: Entitlements): number {
  const cap = can('history', entitlements) ? planLimits('pro').historyItems : limitsFor(entitlements.plan, entitlements.policy).historyItems;
  return Math.max(0, Math.min(requested, cap));
}

/** How many alerts may exist (0 = alerts are not part of the plan). */
export function alertLimit(entitlements: Entitlements): number {
  return can('alerts', entitlements) ? planLimits('pro').alerts : limitsFor(entitlements.plan, entitlements.policy).alerts;
}

/** How many markets the watchlist may hold (0 = not part of the plan). */
export function watchlistLimit(entitlements: Entitlements): number {
  return can('watchlist', entitlements) ? planLimits('pro').watchlist : limitsFor(entitlements.plan, entitlements.policy).watchlist;
}
