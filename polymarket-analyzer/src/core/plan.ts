import type { HistoryRange } from './types';

/**
 * The plan seam (docs/MONETIZATION.md). Every plan-dependent decision, in the popup, the options
 * page and the background alert checks, goes through `hasFeature` / `limitsFor` with the
 * *effective* plan from `effectivePlan`. Switching payments on later means flipping
 * EARLY_ACCESS and letting a future `src/payments/` adapter store `plan: 'pro'`; no UI rewrite.
 *
 * Pure: no Chrome APIs, no payment SDK code.
 */

export type Plan = 'free' | 'pro';

export const PRO_FEATURES = ['alerts', 'unlimitedWatchlist', 'compare', 'chart30d'] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$2.99';

/** What free includes, for the About Pro card. Never paywalled: this is the core job of the listing. */
export const FREE_INCLUDES: readonly string[] = [
  'Full market analysis: probability, momentum, volume, liquidity, unusual activity, related markets',
  'Watchlist of up to 5 markets, refreshed in the popup',
  '24H and 7D charts, search, history of your analyses',
];

/** Copy for the About Pro card and the PRO badges. */
export const PRO_FEATURE_INFO: Record<ProFeature, { title: string; text: string }> = {
  alerts: {
    title: 'Background alerts',
    text: 'Checks your watchlist every 15 minutes and shows a notification when a market moves more than your threshold, volume jumps or momentum flips.',
  },
  unlimitedWatchlist: { title: 'Unlimited watchlist', text: 'Watch as many markets as you like (free keeps 5).' },
  compare: { title: 'Compare view', text: 'Two or three markets side by side: probability, changes, volume, liquidity and momentum.' },
  chart30d: { title: '30D charts', text: 'A 30-day price chart with significant moves marked.' },
};

export interface PlanLimits {
  /** Markets on the watchlist. `Infinity` = no plan limit (storage still has a safety cap). */
  watchlist: number;
  chartRanges: readonly HistoryRange[];
}

const LIMITS: Record<Plan, PlanLimits> = {
  free: { watchlist: 5, chartRanges: ['24h', '7d'] },
  pro: { watchlist: Number.POSITIVE_INFINITY, chartRanges: ['24h', '7d', '30d'] },
};

/** Saved analyses (History). The same for both plans: it's the user's own data, not a Pro feature. */
export const HISTORY_LIMIT = 100;

export function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'pro';
}

/**
 * The plan features are checked against. While EARLY_ACCESS is on, that's Pro for everyone,
 * so `hasFeature(effectivePlan(stored), anything)` is true.
 */
export function effectivePlan(stored: Plan, earlyAccess: boolean = EARLY_ACCESS): Plan {
  return earlyAccess ? 'pro' : stored;
}

export function hasFeature(plan: Plan, feature: ProFeature): boolean {
  return plan === 'pro' && PRO_FEATURES.includes(feature);
}

export function limitsFor(plan: Plan): PlanLimits {
  return LIMITS[plan];
}

/** Calm inline message when a free user reaches the watchlist limit. */
export function watchlistLimitMessage(limit: number): string {
  return `Free keeps ${limit} markets on the watchlist. Pro removes the limit.`;
}
