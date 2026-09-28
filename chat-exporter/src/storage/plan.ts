import { EARLY_ACCESS, hasFeature, limitsFor, sanitizePlan, type Limits, type Plan, type ProFeature } from '../core/plan';

/**
 * The stored plan (`plan` in chrome.storage.local, sanitized on read, default 'free'). Only a
 * future payments adapter writes it.
 */

const KEY = 'plan';
/** e2e build only: lets tests see the free tier while EARLY_ACCESS is on. Compiled out of dist/. */
const E2E_EARLY_ACCESS_KEY = 'e2eEarlyAccess';

export interface PlanState {
  plan: Plan;
  earlyAccess: boolean;
  has(feature: ProFeature): boolean;
  limits: Limits;
}

export function planState(plan: Plan, earlyAccess: boolean = EARLY_ACCESS): PlanState {
  return { plan, earlyAccess, has: (feature) => hasFeature(plan, feature, earlyAccess), limits: limitsFor(plan, earlyAccess) };
}

function fromStorage(data: Record<string, unknown>): PlanState {
  let earlyAccess = EARLY_ACCESS;
  if (__E2E__ && typeof data[E2E_EARLY_ACCESS_KEY] === 'boolean') earlyAccess = data[E2E_EARLY_ACCESS_KEY];
  return planState(sanitizePlan(data[KEY]), earlyAccess);
}

/** Falls back to the free plan (plus early access) when storage can't be read. */
export async function loadPlan(): Promise<PlanState> {
  try {
    return fromStorage(await chrome.storage.local.get(__E2E__ ? [KEY, E2E_EARLY_ACCESS_KEY] : KEY));
  } catch {
    return planState('free');
  }
}

export function onPlanChanged(listener: (state: PlanState) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes[KEY] || (__E2E__ && changes[E2E_EARLY_ACCESS_KEY]))) return;
    void loadPlan().then(listener);
  });
}
