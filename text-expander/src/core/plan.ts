/**
 * Free vs Pro (see docs/MONETIZATION.md at the repository root). Pure, no Chrome APIs and no
 * payment code: a future `src/payments/` adapter only sets the stored plan.
 *
 * Every Pro check in the UI, the content script and the store goes through `hasFeature` or
 * `limitsFor`.
 */

import { LIMITS } from './snippets';

export type Plan = 'free' | 'pro';

export type ProFeature = 'unlimited-snippets' | 'tags' | 'fill-in-fields';

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;

export const PRO_PRICE = '$3.99';

export const FREE_SNIPPET_LIMIT = 20;

export interface PlanLimits {
  /** How many snippets can exist before adding new ones is blocked. Existing ones are never touched. */
  maxSnippets: number;
}

/** The stored plan plus whether early access applies (always EARLY_ACCESS outside tests). */
export interface PlanState {
  plan: Plan;
  earlyAccess: boolean;
}

export function defaultPlanState(): PlanState {
  return { plan: 'free', earlyAccess: EARLY_ACCESS };
}

/** Anything read from storage becomes a valid plan; unknown values mean free. */
export function sanitizePlan(raw: unknown): Plan {
  return raw === 'pro' ? 'pro' : 'free';
}

export function hasFeature(plan: Plan, feature: ProFeature, earlyAccess: boolean = EARLY_ACCESS): boolean {
  if (earlyAccess || plan === 'pro') return true;
  switch (feature) {
    case 'unlimited-snippets':
    case 'tags':
    case 'fill-in-fields':
      return false;
  }
}

export function limitsFor(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): PlanLimits {
  // "Unlimited" still has the technical ceiling every snippet library has.
  return { maxSnippets: hasFeature(plan, 'unlimited-snippets', earlyAccess) ? LIMITS.snippetsMax : FREE_SNIPPET_LIMIT };
}

/** True when `adding` more snippets fit next to `current` ones. */
export function canAddSnippets(state: PlanState, current: number, adding = 1): boolean {
  return current + adding <= limitsFor(state.plan, state.earlyAccess).maxSnippets;
}

/** True when the free limit (not the technical one) is what stops adding. */
export function isFreeLimit(state: PlanState): boolean {
  return !hasFeature(state.plan, 'unlimited-snippets', state.earlyAccess);
}

/** The calm message shown when a free user reaches the limit. */
export function freeLimitMessage(): string {
  return `Free keeps ${FREE_SNIPPET_LIMIT} snippets. Pro removes the limit.`;
}

export type PlanLabel = 'Early access' | 'Pro' | 'Free';

export function planLabel(state: PlanState): PlanLabel {
  if (state.plan === 'pro') return 'Pro';
  return state.earlyAccess ? 'Early access' : 'Free';
}

export interface ProFeatureInfo {
  feature: ProFeature;
  title: string;
  description: string;
}

/** What the "About Pro" card lists. */
export const PRO_FEATURES: readonly ProFeatureInfo[] = [
  { feature: 'unlimited-snippets', title: 'Unlimited snippets', description: `Free keeps ${FREE_SNIPPET_LIMIT}.` },
  { feature: 'tags', title: 'Tags', description: 'Group snippets like folders and filter by tag in the manager and the popup.' },
  {
    feature: 'fill-in-fields',
    title: 'Fill-in fields',
    description: '{input:Name} asks for a value and {choice:…} offers a dropdown when the snippet expands.',
  },
];
