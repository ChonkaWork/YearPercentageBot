/**
 * Free vs Pro (see docs/MONETIZATION.md at the repo root). Pure: no Chrome APIs, no payment
 * code. A future `src/payments/` adapter verifies a license and stores `plan: 'pro'`; every
 * Pro check in the UI and the background goes through `hasFeature` / `limitsFor`.
 */

export type Plan = 'free' | 'pro';

export type ProFeature =
  /** User-defined actions (name + instruction) in the menu, panel and popup. */
  | 'templates'
  /** Keep up to PRO_HISTORY_LIMIT prompts instead of FREE_HISTORY_LIMIT. */
  | 'long-history'
  /** Search box above the history list in the popup. */
  | 'history-search'
  /** Pin prompts so they stay on top and are never rotated out. */
  | 'pinned-history';

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$2.99';

export const FREE_HISTORY_LIMIT = 20;
export const PRO_HISTORY_LIMIT = 500;
/** Sanity cap on custom templates (a menu with more entries stops being useful). Not a plan limit. */
export const MAX_TEMPLATES = 50;

export interface Limits {
  /** Most prompts history can hold. The "Recent prompts to keep" setting can only lower it. */
  maxHistoryItems: number;
  /** Custom templates that can be created (0 on the free plan). */
  maxTemplates: number;
}

/** What the "About Pro" card lists, in order. */
export const PRO_FEATURES: readonly { feature: ProFeature; title: string; description: string }[] = [
  {
    feature: 'templates',
    title: 'Custom templates',
    description: 'Your own actions with your own instruction, in the right-click menu, the panel and the popup.',
  },
  {
    feature: 'long-history',
    title: `History up to ${PRO_HISTORY_LIMIT}`,
    description: `Free keeps the last ${FREE_HISTORY_LIMIT} prompts. Pro keeps up to ${PRO_HISTORY_LIMIT}.`,
  },
  { feature: 'history-search', title: 'History search', description: 'Find an old prompt by any word in it, its page or its source.' },
  { feature: 'pinned-history', title: 'Pinned favourites', description: 'Pin the prompts you reuse. They stay on top and never rotate out.' },
];

export function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'pro';
}

/** The stored plan is untrusted: anything unexpected is the free plan. */
export function sanitizePlan(raw: unknown): Plan {
  return isPlan(raw) ? raw : 'free';
}

/** `earlyAccess` is a parameter only so tests (and the e2e build) can check the paid behavior. */
export function hasFeature(plan: Plan, feature: ProFeature, earlyAccess: boolean = EARLY_ACCESS): boolean {
  if (earlyAccess) return true;
  return plan === 'pro' && PRO_FEATURES.some((item) => item.feature === feature);
}

export function limitsFor(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): Limits {
  const pro = (feature: ProFeature) => hasFeature(plan, feature, earlyAccess);
  return {
    maxHistoryItems: pro('long-history') ? PRO_HISTORY_LIMIT : FREE_HISTORY_LIMIT,
    maxTemplates: pro('templates') ? MAX_TEMPLATES : 0,
  };
}

/**
 * How many prompts history may hold after the next save. `requested` is the user's setting.
 * When the plan (not the user) is what limits it, e.g. after Pro ended, prompts that are
 * already saved are never deleted: history rotates at its current size instead of shrinking.
 */
export function historyCap(requested: number, limits: Limits, existingCount: number): number {
  const wanted = Math.max(0, requested);
  if (wanted <= limits.maxHistoryItems) return wanted;
  return Math.max(limits.maxHistoryItems, Math.min(existingCount, wanted));
}

/** True when a free history is full, so the popup can explain what Pro changes. */
export function isHistoryAtFreeLimit(count: number, limits: Limits): boolean {
  return limits.maxHistoryItems < PRO_HISTORY_LIMIT && count >= limits.maxHistoryItems;
}

/** Calm one-liners shown where a free user meets a limit. Never a blocker, never a nag. */
export function limitMessage(topic: 'history' | 'templates' | 'history-search' | 'pinned-history'): string {
  switch (topic) {
    case 'history':
      return `Free keeps the last ${FREE_HISTORY_LIMIT} prompts. Pro keeps up to ${PRO_HISTORY_LIMIT}, with search and pins.`;
    case 'templates':
      return 'Custom templates are part of Pro. Templates you already made are kept.';
    case 'history-search':
      return 'Searching history is part of Pro.';
    case 'pinned-history':
      return 'Pinning is part of Pro. Prompts you already pinned stay pinned.';
  }
}
