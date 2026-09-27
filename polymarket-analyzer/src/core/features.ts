import type { HistoryRange } from './types';

/**
 * Feature gating. Every plan-dependent decision in the UI goes through this module so that
 * a paid plan can be introduced later by changing data, not code paths.
 *
 * MVP behaviour (early access): EARLY_ACCESS is on, so everyone gets the Pro feature set and
 * Pro limits. Pro features carry a small "PRO" badge so nothing changes silently when plans
 * arrive. There are no payments, accounts or license checks in the extension.
 */

export type Plan = 'free' | 'pro';

export const FEATURES = ['basicAnalysis', 'alerts', 'relatedMarkets', 'unusualActivity', 'comparisons', 'extendedHistory'] as const;
export type Feature = (typeof FEATURES)[number];

const REQUIRED_PLAN: Record<Feature, Plan> = {
  basicAnalysis: 'free',
  alerts: 'pro',
  relatedMarkets: 'pro',
  unusualActivity: 'pro',
  comparisons: 'pro',
  // 30-day chart and the longer analysis history.
  extendedHistory: 'pro',
};

export interface PlanLimits {
  watchlist: number;
  history: number;
  chartRanges: readonly HistoryRange[];
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { watchlist: 5, history: 10, chartRanges: ['24h', '7d'] },
  pro: { watchlist: 50, history: 100, chartRanges: ['24h', '7d', '30d'] },
};

/** Early access: all Pro features unlocked for everyone. */
export const EARLY_ACCESS = true;

export function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'pro';
}

/** The plan features are checked against. */
export function effectivePlan(stored: Plan, earlyAccess: boolean = EARLY_ACCESS): Plan {
  return earlyAccess ? 'pro' : stored;
}

export function hasFeature(plan: Plan, feature: Feature): boolean {
  return REQUIRED_PLAN[feature] === 'free' || plan === 'pro';
}

/** True for features that get a "PRO" badge. */
export function isProFeature(feature: Feature): boolean {
  return REQUIRED_PLAN[feature] === 'pro';
}

export function limitsFor(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan];
}
