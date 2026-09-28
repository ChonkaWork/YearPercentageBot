/**
 * Free vs Pro (see docs/MONETIZATION.md at the repo root). Pure: no Chrome APIs, no payment code.
 * A future `src/payments/` adapter sets the stored plan; everything else asks this file.
 */

export type Plan = 'free' | 'pro';

export type ProFeature =
  /** More than FREE_MAX_CONVERSATIONS saved conversations. */
  | 'unlimited-index'
  /** Star conversations and filter by "Starred". */
  | 'favourites'
  /** Add tags to conversations, filter and search by tag. */
  | 'tags'
  /** Download the whole index as JSON. */
  | 'export';

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$2.99';
/** Free keeps this many conversations; the rest aren't saved (existing ones are never deleted). */
export const FREE_MAX_CONVERSATIONS = 100;

export interface Limits {
  /** Saved conversations; Infinity when unlimited. */
  maxConversations: number;
}

/** What the "About Pro" card lists, in order. */
export const PRO_FEATURES: readonly { feature: ProFeature; title: string; description: string }[] = [
  { feature: 'unlimited-index', title: 'Unlimited index', description: `Free keeps ${FREE_MAX_CONVERSATIONS} conversations. Pro saves and searches all of them.` },
  { feature: 'favourites', title: 'Favourites', description: 'Star the conversations you come back to and filter by “Starred”.' },
  { feature: 'tags', title: 'Tags', description: 'Tag conversations, filter by tag, and find them by tag in search.' },
  { feature: 'export', title: 'Export the index', description: 'Download everything that is saved as one JSON file.' },
];

export function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'pro';
}

/** The stored plan, sanitized: anything unexpected is 'free'. */
export function sanitizePlan(raw: unknown): Plan {
  return isPlan(raw) ? raw : 'free';
}

export function hasFeature(plan: Plan, _feature: ProFeature, earlyAccess: boolean = EARLY_ACCESS): boolean {
  return earlyAccess || plan === 'pro';
}

export function limitsFor(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): Limits {
  return { maxConversations: hasFeature(plan, 'unlimited-index', earlyAccess) ? Infinity : FREE_MAX_CONVERSATIONS };
}

/** The index can't take new conversations (updates to saved ones still go through). */
export function isIndexFull(count: number, limits: Limits): boolean {
  return count >= limits.maxConversations;
}

/** The calm message shown when a free index is full. */
export function limitMessage(limits: Limits): string {
  return `Free keeps ${limits.maxConversations.toLocaleString('en-US')} conversations. New ones aren't saved; everything already saved stays searchable. Pro removes the limit.`;
}
