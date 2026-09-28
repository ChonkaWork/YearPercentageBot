/** Reads the stored plan (sanitized). Small on purpose: the content script bundles it. */

import { EARLY_ACCESS, sanitizePlan, type PlanState } from '../core/plan';
import { E2E_EARLY_ACCESS_KEY, PLAN_KEY } from './keys';

/** Storage keys that affect the plan. */
export const PLAN_KEYS: readonly string[] = __E2E__ ? [PLAN_KEY, E2E_EARLY_ACCESS_KEY] : [PLAN_KEY];

export function planStateFrom(data: Record<string, unknown>): PlanState {
  // Test build only: lets the e2e test see the free plan while EARLY_ACCESS is on.
  const earlyAccess = __E2E__ && data[E2E_EARLY_ACCESS_KEY] === false ? false : EARLY_ACCESS;
  return { plan: sanitizePlan(data[PLAN_KEY]), earlyAccess };
}

export async function loadPlanState(): Promise<PlanState> {
  return planStateFrom(await chrome.storage.local.get([...PLAN_KEYS]));
}

export function isPlanChange(changes: Record<string, unknown>): boolean {
  return PLAN_KEYS.some((key) => key in changes);
}
