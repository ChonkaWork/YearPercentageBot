/**
 * Free vs Pro (see docs/MONETIZATION.md, "The plan seam"). Pure, no Chrome APIs.
 *
 * Every Pro check in the UI and in the content script goes through `hasFeature` / `limitsFor`.
 * No payment code lives here: a future src/payments/ adapter only writes the stored plan.
 */

export type Plan = 'free' | 'pro';
export type ProFeature = 'schedule' | 'allowlist' | 'subscriptions-only';

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$1.99';

/** chrome.storage.local key of the stored plan. */
export const PLAN_KEY = 'plan';

/** Most allowlisted channels kept (bounds storage; far more than anyone adds by hand). */
export const MAX_ALLOWLIST = 500;

export interface PlanLimits {
  /** Allowlisted channels that are honored (0: the allowlist is off). */
  maxAllowedChannels: number;
}

/** What the About Pro card lists. */
export const PRO_FEATURES: readonly { id: ProFeature; title: string; text: string }[] = [
  {
    id: 'schedule',
    title: 'Focus schedule',
    text: 'Focus mode turns itself on only on the days and hours you choose, e.g. weekdays 9:00–17:00, or overnight.',
  },
  {
    id: 'allowlist',
    title: 'Channel allowlist',
    text: 'On videos from channels you trust, comments, Up next and end screens stay visible.',
  },
  {
    id: 'subscriptions-only',
    title: 'Subscriptions-only mode',
    text: 'Everything except your subscriptions and search is hidden: no home feed, Explore, Trending or Shorts.',
  },
];

/** Anything read from storage becomes a valid plan; unknown values are 'free'. */
export function sanitizePlan(raw: unknown): Plan {
  return raw === 'pro' ? 'pro' : 'free';
}

/** True when `plan` includes `feature`. During early access every feature is included. */
export function hasFeature(plan: Plan, feature: ProFeature, earlyAccess: boolean = EARLY_ACCESS): boolean {
  if (earlyAccess) return true;
  return plan === 'pro' && PRO_FEATURES.some((entry) => entry.id === feature);
}

export function limitsFor(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): PlanLimits {
  return { maxAllowedChannels: hasFeature(plan, 'allowlist', earlyAccess) ? MAX_ALLOWLIST : 0 };
}

/** Calm, one-line explanation shown next to a Pro control for a free user. */
export function proMessage(feature: ProFeature): string {
  const title = PRO_FEATURES.find((entry) => entry.id === feature)?.title ?? 'This';
  return `${title} is part of YouTube Focus Pro (${PRO_PRICE} once). Your settings are kept.`;
}
