/**
 * Free vs Pro (see docs/MONETIZATION.md at the repo root). Pure: no Chrome APIs and no payment
 * code. A future src/payments/ adapter only writes the stored plan; every Pro check in the UI goes
 * through `hasFeature` / `limitsFor` / `isEntitled` below.
 */

export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

/** Registry tier of a theme, accent or widget. */
export type Tier = Plan;

export type ProFeature = 'unlimited-countdowns' | 'theme-pack' | 'life-in-weeks';

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$1.99';

/** Free keeps this many countdowns; existing ones above it are never removed. */
export const FREE_MAX_COUNTDOWNS = 3;
/**
 * Safety cap for everyone (Pro "unlimited"): keeps storage and the once-a-second update small.
 * Mirrors MAX_COUNTDOWNS in countdown.ts (a unit test keeps them equal).
 */
export const PRO_MAX_COUNTDOWNS = 200;

export interface PlanLimits {
  maxCountdowns: number;
}

/** What the "About Pro" card lists, in order. */
export const PRO_FEATURES: readonly { id: ProFeature; title: string; description: string }[] = [
  { id: 'unlimited-countdowns', title: 'Unlimited countdowns', description: `Free keeps ${FREE_MAX_COUNTDOWNS}.` },
  { id: 'theme-pack', title: 'Theme pack', description: 'Paper, Slate, Sage, Clay and High contrast, each in light and dark.' },
  { id: 'life-in-weeks', title: 'Life in weeks', description: 'Your life as a grid of weeks, from a birth date kept in this browser.' },
];

/** Anything read from storage; unknown values mean free. */
export function sanitizePlan(raw: unknown): Plan {
  return raw === 'pro' ? 'pro' : 'free';
}

export function hasFeature(plan: Plan, _feature: ProFeature, earlyAccess: boolean = EARLY_ACCESS): boolean {
  return earlyAccess || plan === 'pro';
}

export function limitsFor(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): PlanLimits {
  return { maxCountdowns: hasFeature(plan, 'unlimited-countdowns', earlyAccess) ? PRO_MAX_COUNTDOWNS : FREE_MAX_COUNTDOWNS };
}

/** Registry entries (themes, widgets) say which tier they belong to and, if Pro, which feature. */
export type Tiered = { readonly tier: 'free'; readonly feature?: undefined } | { readonly tier: 'pro'; readonly feature: ProFeature };

export function isEntitled(entry: Tiered, plan: Plan, earlyAccess: boolean = EARLY_ACCESS): boolean {
  return entry.tier === 'free' || hasFeature(plan, entry.feature, earlyAccess);
}

/** Whether one more countdown may be added to a list of `count`. Editing and deleting are always allowed. */
export function canAddCountdown(count: number, plan: Plan, earlyAccess: boolean = EARLY_ACCESS): boolean {
  return count < limitsFor(plan, earlyAccess).maxCountdowns;
}

/** The calm message shown when a free user reaches the countdown limit. */
export function countdownLimitMessage(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): string {
  const { maxCountdowns } = limitsFor(plan, earlyAccess);
  if (maxCountdowns === FREE_MAX_COUNTDOWNS) return `Free keeps ${FREE_MAX_COUNTDOWNS} countdowns. Pro removes the limit.`;
  return `You can have up to ${maxCountdowns} countdowns. Delete one to add another.`;
}
