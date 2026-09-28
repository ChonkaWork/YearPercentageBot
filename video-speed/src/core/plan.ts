/**
 * Free vs Pro (see docs/MONETIZATION.md, "The plan seam"). Pure, no Chrome APIs.
 *
 * Every Pro check in the UI and in the content script goes through `hasFeature` / `limitsFor`.
 * No payment code lives here: a future src/payments/ adapter only writes the stored plan.
 */

export type Plan = 'free' | 'pro';
export type ProFeature = 'site-defaults' | 'custom-presets';

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$1.99';

/** chrome.storage.local key of the stored plan. */
export const PLAN_KEY = 'plan';

/** Most per-site default speeds kept (bounds storage; far more than anyone types by hand). */
export const MAX_SITE_DEFAULTS = 500;
/** Most preset buttons in the popup (two rows of four). */
export const MAX_PRESETS = 8;

export interface PlanLimits {
  /** Per-site default speed rules that are applied (0: the feature is off). */
  maxSiteDefaults: number;
  /** Preset buttons the user can define (0: the built-in presets are used). */
  maxCustomPresets: number;
}

/** What the About Pro card lists. */
export const PRO_FEATURES: readonly { id: ProFeature; title: string; text: string }[] = [
  {
    id: 'site-defaults',
    title: 'Per-site default speeds',
    text: 'Videos on a site start at the speed you chose for it, e.g. 1.5× on a course site and 1× on music sites.',
  },
  {
    id: 'custom-presets',
    title: 'Custom presets',
    text: 'Choose the preset buttons in the popup (up to 8 speeds).',
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
  return {
    maxSiteDefaults: hasFeature(plan, 'site-defaults', earlyAccess) ? MAX_SITE_DEFAULTS : 0,
    maxCustomPresets: hasFeature(plan, 'custom-presets', earlyAccess) ? MAX_PRESETS : 0,
  };
}
