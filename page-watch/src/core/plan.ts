import type { ChangeMode } from './types';

/**
 * Free vs Pro. Every plan check in the UI and in the service worker goes through
 * `hasFeature` / `limitsFor` (and the helpers below built on them). No payment code lives
 * here: a future `src/payments/` adapter only sets the stored plan.
 */

export type Plan = 'free' | 'pro';

export type ProFeature =
  /** More than FREE_MAX_WATCHES watches. */
  | 'unlimited-watches'
  /** Checks more often than every hour. */
  | 'fast-intervals'
  /** "A number or price changes". */
  | 'number-rule'
  /** "A keyword appears or disappears". */
  | 'keyword-rule'
  /** "The price drops below a target". */
  | 'price-rule'
  /** Hold notifications during quiet hours and summarize them afterwards. */
  | 'quiet-hours';

export const PRO_FEATURES: readonly ProFeature[] = [
  'unlimited-watches',
  'fast-intervals',
  'number-rule',
  'keyword-rule',
  'price-rule',
  'quiet-hours',
];

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$3.99';

export const FREE_MAX_WATCHES = 3;
export const FREE_MIN_INTERVAL_MINUTES = 60;
export const PRO_MIN_INTERVAL_MINUTES = 5;

let earlyAccess: boolean = EARLY_ACCESS;

/**
 * Test builds only (unit tests, and the e2e build behind `__E2E__`) switch early access off to
 * exercise the free plan. Production code never calls this.
 */
export function setEarlyAccessForTesting(value: boolean): void {
  earlyAccess = value;
}

export function isEarlyAccess(): boolean {
  return earlyAccess;
}

/** The stored plan, sanitized: anything unexpected is 'free'. */
export function sanitizePlan(raw: unknown): Plan {
  return raw === 'pro' ? 'pro' : 'free';
}

export function hasFeature(plan: Plan, _feature: ProFeature): boolean {
  return earlyAccess || plan === 'pro';
}

export interface PlanLimits {
  /** Watches that can be added (existing ones over the limit keep working). */
  maxWatches: number;
  /** Shortest check interval that can be chosen. */
  minIntervalMinutes: number;
}

export function limitsFor(plan: Plan): PlanLimits {
  return {
    maxWatches: hasFeature(plan, 'unlimited-watches') ? Number.POSITIVE_INFINITY : FREE_MAX_WATCHES,
    minIntervalMinutes: hasFeature(plan, 'fast-intervals') ? PRO_MIN_INTERVAL_MINUTES : FREE_MIN_INTERVAL_MINUTES,
  };
}

/** The Pro feature a change rule needs, or null for rules every plan has. */
export function ruleFeature(mode: ChangeMode): ProFeature | null {
  switch (mode) {
    case 'number':
      return 'number-rule';
    case 'keyword':
      return 'keyword-rule';
    case 'below':
      return 'price-rule';
    default:
      return null;
  }
}

export function isRuleAllowed(plan: Plan, mode: ChangeMode): boolean {
  const feature = ruleFeature(mode);
  return feature === null || hasFeature(plan, feature);
}

export function isIntervalAllowed(plan: Plan, minutes: number): boolean {
  return minutes >= limitsFor(plan).minIntervalMinutes;
}

/** An interval this plan can use: the one given, or the shortest allowed one. */
export function allowedInterval<T extends number>(plan: Plan, minutes: T, fallback: T): T {
  return isIntervalAllowed(plan, minutes) ? minutes : fallback;
}

export function canAddWatch(plan: Plan, watchCount: number): boolean {
  return watchCount < limitsFor(plan).maxWatches;
}

export const LIMIT_MESSAGE = `Free keeps ${FREE_MAX_WATCHES} watches. Pro removes the limit.`;
export const INTERVAL_MESSAGE = 'Checks more often than every hour are part of Pro.';
export const RULE_MESSAGE = 'This rule is part of Pro. On the free plan, Page Watch notifies you of any text change.';

export interface PlanChoice {
  intervalMinutes: number;
  mode: ChangeMode;
}

/**
 * Why this plan can't use these settings, or null. Values in `keep` (a watch's current
 * settings) stay allowed: a watch set up on Pro keeps working as it is.
 */
export function planProblem(plan: Plan, choice: Partial<PlanChoice>, keep?: PlanChoice): string | null {
  if (choice.mode !== undefined && choice.mode !== keep?.mode && !isRuleAllowed(plan, choice.mode)) return RULE_MESSAGE;
  if (
    choice.intervalMinutes !== undefined &&
    choice.intervalMinutes !== keep?.intervalMinutes &&
    !isIntervalAllowed(plan, choice.intervalMinutes)
  ) {
    return INTERVAL_MESSAGE;
  }
  return null;
}
