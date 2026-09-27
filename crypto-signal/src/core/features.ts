import type { Interval } from './types';

/**
 * Feature gating. Every plan check in the extension goes through this module, so turning on a
 * paid plan later means changing the policy here, not hunting through the UI.
 *
 * MVP decision: there are no payments. The extension ships in "early access" where every
 * feature is unlocked for everyone; the UI marks what would be Pro with a small badge.
 * Settings has a "Preview Free plan limits" switch that applies the Free column below, so the
 * gated experience can be tried and tested without any billing code.
 */

export type Plan = 'free' | 'pro';

export type Feature =
  /** Coins other than the Free ones (BTC, ETH). */
  | 'allCoins'
  /** More analyses per day than the Free daily limit. */
  | 'unlimitedAnalyses'
  /** Momentum and volume details, EMA overlays on the chart. */
  | 'advancedIndicators'
  /** Full analysis history (Free keeps the last few). */
  | 'history'
  /** Signal alerts (architecture only in the MVP). */
  | 'alerts'
  /** Timeframes other than the Free one (4h). */
  | 'allTimeframes';

export const FEATURES: readonly Feature[] = ['allCoins', 'unlimitedAnalyses', 'advancedIndicators', 'history', 'alerts', 'allTimeframes'];

export interface PlanLimits {
  /** null = any coin. */
  coins: readonly string[] | null;
  /** Fresh (non-cached) analyses per local day. null = unlimited. */
  dailyAnalyses: number | null;
  timeframes: readonly Interval[];
  /** Upper bound for stored history entries. */
  historyItems: number;
}

const PLAN_FEATURES: Readonly<Record<Plan, ReadonlySet<Feature>>> = {
  free: new Set<Feature>(),
  pro: new Set<Feature>(FEATURES),
};

const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: { coins: ['BTC', 'ETH'], dailyAnalyses: 10, timeframes: ['4h'], historyItems: 5 },
  pro: { coins: null, dailyAnalyses: null, timeframes: ['1h', '4h', '1d'], historyItems: 50 },
};

/**
 * How plans are applied.
 * - 'early-access': everything unlocked regardless of plan (what the MVP ships).
 * - 'enforced': the plan matrix applies.
 */
export type GatingPolicy = 'early-access' | 'enforced';

export interface Entitlements {
  plan: Plan;
  policy: GatingPolicy;
}

/** The MVP: plan is hard-coded to Free, and nothing is enforced. */
export const DEFAULT_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({ plan: 'free', policy: 'early-access' });

/** The "Preview Free plan limits" developer switch. */
export function entitlementsFor(previewFreePlan: boolean): Entitlements {
  return previewFreePlan ? { plan: 'free', policy: 'enforced' } : { ...DEFAULT_ENTITLEMENTS };
}

export function isEnabled(feature: Feature, plan: Plan, policy: GatingPolicy = DEFAULT_ENTITLEMENTS.policy): boolean {
  if (policy === 'early-access') return true;
  return PLAN_FEATURES[plan].has(feature);
}

/** The lowest plan that includes a feature (used for "Pro" badges). */
export function requiredPlan(feature: Feature): Plan {
  return PLAN_FEATURES.free.has(feature) ? 'free' : 'pro';
}

export function limitsFor(entitlements: Entitlements): PlanLimits {
  return entitlements.policy === 'early-access' ? PLAN_LIMITS.pro : PLAN_LIMITS[entitlements.plan];
}

export function planLimits(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan];
}

export function canUseCoin(symbol: string, entitlements: Entitlements): boolean {
  if (isEnabled('allCoins', entitlements.plan, entitlements.policy)) return true;
  return PLAN_LIMITS[entitlements.plan].coins?.includes(symbol.toUpperCase()) ?? true;
}

export function canUseTimeframe(interval: Interval, entitlements: Entitlements): boolean {
  if (isEnabled('allTimeframes', entitlements.plan, entitlements.policy)) return true;
  return PLAN_LIMITS[entitlements.plan].timeframes.includes(interval);
}

/** Would this coin / timeframe be Pro-only under an enforced Free plan? (For badges.) */
export function isProCoin(symbol: string): boolean {
  return !(PLAN_LIMITS.free.coins?.includes(symbol.toUpperCase()) ?? true);
}

export function isProTimeframe(interval: Interval): boolean {
  return !PLAN_LIMITS.free.timeframes.includes(interval);
}

/** Remaining fresh analyses today, or null when unlimited. */
export function remainingAnalyses(usedToday: number, entitlements: Entitlements): number | null {
  if (isEnabled('unlimitedAnalyses', entitlements.plan, entitlements.policy)) return null;
  const limit = PLAN_LIMITS[entitlements.plan].dailyAnalyses;
  return limit === null ? null : Math.max(0, limit - Math.max(0, usedToday));
}

export function historyLimit(requested: number, entitlements: Entitlements): number {
  const cap = isEnabled('history', entitlements.plan, entitlements.policy)
    ? PLAN_LIMITS.pro.historyItems
    : PLAN_LIMITS[entitlements.plan].historyItems;
  return Math.max(0, Math.min(requested, cap));
}
