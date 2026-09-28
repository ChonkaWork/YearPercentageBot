import type { Interval } from './types';

/**
 * The plan seam (see docs/MONETIZATION.md). Pure and payment-free: a future `src/payments/`
 * adapter only writes the stored plan (`chrome.storage.local` → `plan`). Every Pro check in the
 * popup and in the service worker goes through `hasFeature` / `limitsFor` (directly or through
 * the helpers in `features.ts`), never through a scattered `if (pro)`.
 */

export type Plan = 'free' | 'pro';

export type ProFeature =
  /** Coins other than the Free ones (BTC, ETH). */
  | 'allCoins'
  /** Timeframes other than the Free one (4h). */
  | 'allTimeframes'
  /** More fresh analyses per day than the Free daily limit. */
  | 'unlimitedAnalyses'
  /** Momentum and volume details, EMA overlays on the chart. */
  | 'advancedIndicators'
  /** Full analysis history (Free keeps the last few). */
  | 'history'
  /** Background alerts: chrome.alarms checks + notifications. */
  | 'alerts'
  /** Watchlist of markets with their last signal, refreshed by the background checks. */
  | 'watchlist';

export const PRO_FEATURES: readonly ProFeature[] = ['allCoins', 'allTimeframes', 'unlimitedAnalyses', 'advancedIndicators', 'history', 'alerts', 'watchlist'];

/** Until payments are configured, everyone gets Pro ("early access"). Flip to false at launch. */
export const EARLY_ACCESS = true;

/** One-time price shown on the About Pro card. */
export const PRO_PRICE = '$2.99';

/** chrome.storage.local key of the stored plan. */
export const PLAN_STORAGE_KEY = 'plan';

export interface PlanLimits {
  /** null = any coin. */
  coins: readonly string[] | null;
  /** Fresh (non-cached) analyses per local day. null = unlimited. */
  dailyAnalyses: number | null;
  timeframes: readonly Interval[];
  /** Upper bound for stored history entries. */
  historyItems: number;
  /** Background alerts that can exist. */
  alerts: number;
  /** Markets on the watchlist. */
  watchlist: number;
}

const FREE_LIMITS: PlanLimits = { coins: ['BTC', 'ETH'], dailyAnalyses: 10, timeframes: ['4h'], historyItems: 5, alerts: 0, watchlist: 0 };
const PRO_LIMITS: PlanLimits = { coins: null, dailyAnalyses: null, timeframes: ['1h', '4h', '1d'], historyItems: 50, alerts: 10, watchlist: 8 };
Object.freeze(FREE_LIMITS);
Object.freeze(PRO_LIMITS);
const PLAN_LIMITS: Readonly<Record<Plan, Readonly<PlanLimits>>> = Object.freeze({ free: FREE_LIMITS, pro: PRO_LIMITS });

const PLAN_FEATURES: Readonly<Record<Plan, ReadonlySet<ProFeature>>> = {
  free: new Set<ProFeature>(),
  pro: new Set<ProFeature>(PRO_FEATURES),
};

/**
 * How plans are applied.
 * - 'early-access': everything unlocked regardless of plan (while EARLY_ACCESS is true).
 * - 'enforced': the plan matrix applies (after launch, and in the "Preview Free plan limits" mode).
 */
export type GatingPolicy = 'early-access' | 'enforced';

export const DEFAULT_POLICY: GatingPolicy = EARLY_ACCESS ? 'early-access' : 'enforced';

export interface Entitlements {
  plan: Plan;
  policy: GatingPolicy;
}

export function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'pro';
}

/** The stored plan, sanitized: anything unexpected is Free. */
export function sanitizePlan(raw: unknown): Plan {
  return isPlan(raw) ? raw : 'free';
}

export function hasFeature(plan: Plan, feature: ProFeature, policy: GatingPolicy = DEFAULT_POLICY): boolean {
  if (policy === 'early-access') return true;
  return PLAN_FEATURES[plan].has(feature);
}

/** The limits that apply: Pro's during early access, otherwise the plan's own. */
export function limitsFor(plan: Plan, policy: GatingPolicy = DEFAULT_POLICY): Readonly<PlanLimits> {
  return policy === 'early-access' ? PLAN_LIMITS.pro : PLAN_LIMITS[plan];
}

/** The limits of a plan as sold, regardless of early access (for the plan table and messages). */
export function planLimits(plan: Plan): Readonly<PlanLimits> {
  return PLAN_LIMITS[plan];
}

/**
 * What applies right now. The "Preview Free plan limits" switch enforces the Free plan even
 * during early access, so the gated experience can be reviewed and tested.
 */
export function resolveEntitlements(storedPlan: Plan, previewFreePlan: boolean, earlyAccess: boolean = EARLY_ACCESS): Entitlements {
  if (previewFreePlan) return { plan: 'free', policy: 'enforced' };
  return { plan: storedPlan, policy: earlyAccess ? 'early-access' : 'enforced' };
}

/** The lowest plan that includes a feature (used for "Pro" badges). */
export function requiredPlan(feature: ProFeature): Plan {
  return PLAN_FEATURES.free.has(feature) ? 'free' : 'pro';
}

/** What the About Pro card lists, in order. */
export const PRO_HIGHLIGHTS: readonly { feature: ProFeature; title: string; detail: string }[] = [
  { feature: 'allCoins', title: 'Every coin', detail: 'Any USDT market on Binance, not just BTC and ETH' },
  { feature: 'allTimeframes', title: '1h, 4h and 1d', detail: 'Free uses the 4h chart' },
  { feature: 'unlimitedAnalyses', title: 'Unlimited analyses', detail: 'Free includes 10 fresh analyses a day' },
  { feature: 'alerts', title: 'Background alerts', detail: `Up to ${PLAN_LIMITS.pro.alerts} signal, RSI and price alerts, checked about every 15 minutes` },
  { feature: 'watchlist', title: 'Watchlist', detail: `Up to ${PLAN_LIMITS.pro.watchlist} coins with their last signal` },
  { feature: 'advancedIndicators', title: 'Momentum and volume details', detail: 'Plus EMA overlays on the chart' },
  { feature: 'history', title: 'History up to 50', detail: 'Free keeps the last 5 analyses' },
];
