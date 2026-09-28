/**
 * The plan seam (see docs/MONETIZATION.md). Every Pro check in the UI and in background or
 * content-script code goes through hasFeature / limitsFor. No payment code here: a future
 * src/payments/ adapter only sets the stored plan.
 */

export type Plan = 'free' | 'pro';
export type ProFeature = 'auto-clean' | 'custom-rules';

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$1.99';

export const PRO_FEATURES: readonly { id: ProFeature; title: string; detail: string }[] = [
  {
    id: 'auto-clean',
    title: 'Auto-clean on Ctrl+C',
    detail: 'Every normal copy on the sites you choose comes out clean, no shortcut needed.',
  },
  {
    id: 'custom-rules',
    title: 'Custom cleanup rules',
    detail: 'Your own find and replace steps (plain text or regular expressions), applied after the built-in cleanup.',
  },
];

export function sanitizePlan(raw: unknown): Plan {
  return raw === 'pro' ? 'pro' : 'free';
}

export function hasFeature(plan: Plan, _feature: ProFeature, earlyAccess: boolean = EARLY_ACCESS): boolean {
  return earlyAccess || plan === 'pro';
}

export interface Limits {
  /** Sites with auto-clean. 0 means the feature is off. */
  maxSites: number;
  /** Custom rules that are applied. 0 means the feature is off (rules are kept, never deleted). */
  maxRules: number;
}

export function limitsFor(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): Limits {
  return {
    maxSites: hasFeature(plan, 'auto-clean', earlyAccess) ? 100 : 0,
    maxRules: hasFeature(plan, 'custom-rules', earlyAccess) ? 50 : 0,
  };
}
