/**
 * Free vs Pro (see docs/MONETIZATION.md). Pure: no Chrome APIs, no payment code. A future
 * `src/payments/` adapter verifies a license and stores `plan: 'pro'`; everything else
 * only asks `hasFeature` / `limitsFor`.
 */

export type Plan = 'free' | 'pro';

export type ProFeature = 'download' | 'page-link' | 'markdown-presets';

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;

export const PRO_PRICE = '$2.99';

export const PLANS: readonly Plan[] = ['free', 'pro'];

export const PRO_FEATURES: readonly { id: ProFeature; title: string; description: string }[] = [
  {
    id: 'download',
    title: 'Download as file',
    description: 'Save the selection as a .md file and any table as .csv or .json, from the toolbar popup.',
  },
  {
    id: 'page-link',
    title: 'Copy page link as Markdown',
    description: 'One click for [Page title](https://link), without tracking parameters.',
  },
  {
    id: 'markdown-presets',
    title: 'Markdown presets',
    description: 'Switch the Markdown style for GitHub, Obsidian or plain Markdown in one click.',
  },
];

/** The stored value is untrusted: anything but 'pro' is the free plan. */
export function sanitizePlan(raw: unknown): Plan {
  return raw === 'pro' ? 'pro' : 'free';
}

/** `earlyAccess` is a parameter only so tests can check the paid behavior. */
export function hasFeature(plan: Plan, feature: ProFeature, earlyAccess: boolean = EARLY_ACCESS): boolean {
  if (earlyAccess) return true;
  return plan === 'pro' && PRO_FEATURES.some((item) => item.id === feature);
}

/**
 * Universal Copy has no count limits: Free converts and copies without restriction and Pro
 * adds features. Kept (empty) for the shared plan seam, so a limit can be added in one place.
 */
export type Limits = Readonly<Record<string, never>>;

export function limitsFor(_plan: Plan): Limits {
  return {};
}

/** Calm, one-line explanation shown when a free user tries a Pro feature. */
export function proMessage(feature: ProFeature): string {
  const title = PRO_FEATURES.find((item) => item.id === feature)?.title ?? 'This';
  return `${title} is part of Universal Copy Pro (${PRO_PRICE} once). Everything else stays free.`;
}
