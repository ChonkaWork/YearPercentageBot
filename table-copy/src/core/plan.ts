/**
 * The plan seam (see docs/MONETIZATION.md). Every Pro check in the UI and in background
 * code goes through hasFeature() / limitsFor(). No payment code here: a future
 * src/payments/ adapter only sets the stored plan.
 */

export type Plan = 'free' | 'pro';
export type ProFeature = 'record-rows' | 'xlsx' | 'column-picker' | 'merge-tables';

export const PRO_FEATURES: readonly ProFeature[] = ['record-rows', 'xlsx', 'column-picker', 'merge-tables'];

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;
export const PRO_PRICE = '$2.99';

export const FEATURE_LABELS: Record<ProFeature, string> = {
  'record-rows': 'Record rows',
  xlsx: 'Download .xlsx',
  'column-picker': 'Column picker',
  'merge-tables': 'Merge tables',
};

export const FEATURE_DESCRIPTIONS: Record<ProFeature, string> = {
  'record-rows': 'Every row of grids that only show part of their data: collected while you scroll or page through them.',
  xlsx: 'Real Excel files: numbers as numbers, a bold frozen header, one sheet per table if you like.',
  'column-picker': 'Choose and reorder columns before you copy or download.',
  'merge-tables': 'Collect tables from one or more pages in a basket and export them as one.',
};

export interface Limits {
  /** Tables the basket can hold. */
  basketTables: number;
  /** Cells the basket can hold in total (storage stays small and fast). */
  basketCells: number;
}

export function sanitizePlan(value: unknown): Plan {
  return value === 'pro' ? 'pro' : 'free';
}

export function hasFeature(plan: Plan, feature: ProFeature, earlyAccess: boolean = EARLY_ACCESS): boolean {
  if (earlyAccess) return true;
  return plan === 'pro' && PRO_FEATURES.includes(feature);
}

export function limitsFor(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): Limits {
  if (earlyAccess || plan === 'pro') return { basketTables: 20, basketCells: 250_000 };
  return { basketTables: 0, basketCells: 0 };
}

/** The calm one-line explanation shown when a free user tries a Pro feature. */
export function upgradeMessage(feature: ProFeature): string {
  return `${FEATURE_LABELS[feature]} is part of Table Copy Pro (${PRO_PRICE}, one-time).`;
}
