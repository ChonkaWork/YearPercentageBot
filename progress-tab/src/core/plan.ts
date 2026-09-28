/**
 * Free vs Pro (see docs/MONETIZATION.md at the repo root). Pure: no Chrome APIs and no payment
 * code. A future src/payments/ adapter only writes the stored plan; every Pro check in the UI goes
 * through `hasFeature` / `limitsFor` / `isEntitled` below.
 */

export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

/** Registry tier of a theme, accent or widget. */
export type Tier = Plan;

export type ProFeature = 'unlimited-goals' | 'unlimited-countdowns' | 'unlimited-links' | 'theme-pack' | 'life-in-weeks';

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

/** Free paces one goal against the year; Pro any number (safety cap: MAX_GOALS in goals.ts). */
export const FREE_MAX_GOALS = 1;
export const PRO_MAX_GOALS = 100;

/** Free keeps a row of 6 quick links; Pro any number (safety cap: MAX_LINKS in links.ts). */
export const FREE_MAX_LINKS = 6;
export const PRO_MAX_LINKS = 100;

export interface PlanLimits {
  maxCountdowns: number;
  maxGoals: number;
  maxLinks: number;
}

/** Lists with a free limit. */
export type LimitedList = 'countdowns' | 'goals' | 'links';

/** What the "About Pro" card lists, in order. */
export const PRO_FEATURES: readonly { id: ProFeature; title: string; description: string }[] = [
  { id: 'unlimited-goals', title: 'Unlimited goals', description: `Pace every goal against the year. Free tracks ${FREE_MAX_GOALS}.` },
  { id: 'unlimited-countdowns', title: 'Unlimited countdowns', description: `Free keeps ${FREE_MAX_COUNTDOWNS}.` },
  { id: 'unlimited-links', title: 'Unlimited quick links', description: `Free keeps ${FREE_MAX_LINKS}.` },
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
  return {
    maxCountdowns: hasFeature(plan, 'unlimited-countdowns', earlyAccess) ? PRO_MAX_COUNTDOWNS : FREE_MAX_COUNTDOWNS,
    maxGoals: hasFeature(plan, 'unlimited-goals', earlyAccess) ? PRO_MAX_GOALS : FREE_MAX_GOALS,
    maxLinks: hasFeature(plan, 'unlimited-links', earlyAccess) ? PRO_MAX_LINKS : FREE_MAX_LINKS,
  };
}

const LIST_LIMITS: Record<LimitedList, { key: keyof PlanLimits; feature: ProFeature; free: number; one: string; many: string; keeps: string }> = {
  countdowns: { key: 'maxCountdowns', feature: 'unlimited-countdowns', free: FREE_MAX_COUNTDOWNS, one: 'countdown', many: 'countdowns', keeps: 'keeps' },
  goals: { key: 'maxGoals', feature: 'unlimited-goals', free: FREE_MAX_GOALS, one: 'goal', many: 'goals', keeps: 'tracks' },
  links: { key: 'maxLinks', feature: 'unlimited-links', free: FREE_MAX_LINKS, one: 'quick link', many: 'quick links', keeps: 'keeps' },
};

/** The plan's limit for a list; only adding is ever blocked by it. */
export function listLimit(list: LimitedList, plan: Plan, earlyAccess: boolean = EARLY_ACCESS): number {
  return limitsFor(plan, earlyAccess)[LIST_LIMITS[list].key];
}

/** Whether Pro would lift the limit (the message then links to About Pro). */
export function isUpgradable(list: LimitedList, plan: Plan, earlyAccess: boolean = EARLY_ACCESS): boolean {
  return !hasFeature(plan, LIST_LIMITS[list].feature, earlyAccess);
}

/** The calm message shown when a list is full: "Free keeps 6 quick links. Pro removes the limit." */
export function limitMessage(list: LimitedList, plan: Plan, earlyAccess: boolean = EARLY_ACCESS): string {
  const { free, one, many, keeps } = LIST_LIMITS[list];
  if (isUpgradable(list, plan, earlyAccess)) return `Free ${keeps} ${free} ${free === 1 ? one : many}. Pro removes the limit.`;
  return `You can have up to ${listLimit(list, plan, earlyAccess)} ${many}. Delete one to add another.`;
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
  return limitMessage('countdowns', plan, earlyAccess);
}
