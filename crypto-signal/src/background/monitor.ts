import { notificationFor, notificationId, parseNotificationId, toAlertSnapshot, type AlertEvent, type AlertRule } from '../core/alerts';
import { can, entitlementsFor, type Entitlements } from '../core/features';
import {
  CHECK_PERIOD_MINUTES,
  evaluateMarket,
  marketKey,
  marketsToCheck,
  MIN_MANUAL_GAP_MS,
  needsSchedule,
  pruneMonitorState,
  type Baseline,
  type MarketSnapshot,
} from '../core/monitor';
import { analyze } from '../core/signal';
import { BinanceProvider } from '../data/binance';
import { CoinbaseProvider } from '../data/coinbase';
import { MarketService } from '../data/market';
import { shortReason } from '../popup/messages';
import {
  loadAlerts,
  loadBaselines,
  loadMonitorState,
  loadPlan,
  loadSettings,
  loadWatchlist,
  recordSnapshots,
  saveBaselines,
  saveMonitorState,
  sessionStore,
  setPendingAnalysis,
} from '../storage/store';

/**
 * Background alerts and watchlist refresh (Pro). A chrome.alarms alarm fires every
 * CHECK_PERIOD_MINUTES while there is at least one active alert or watched coin. Each run loads
 * the markets through the same MarketService as the popup, so the 60 s cache, Retry-After and
 * geo-block back-offs are shared and respected, evaluates the alert rules edge-triggered against
 * the previous run and shows a notification for each rule that fired.
 */

export const CHECK_ALARM = 'cryptosignal:check';

const market = new MarketService({ providers: [new BinanceProvider(), new CoinbaseProvider()], store: sessionStore });

async function currentEntitlements(): Promise<Entitlements> {
  const [settings, plan] = await Promise.all([loadSettings(), loadPlan()]);
  return entitlementsFor(settings.previewFreePlan, plan);
}

/** Creates or clears the periodic alarm to match the stored alerts, watchlist and plan. */
export async function syncSchedule(): Promise<boolean> {
  const entitlements = await currentEntitlements();
  const [rules, watchlist] = await Promise.all([loadAlerts().catch(() => []), loadWatchlist().catch(() => [])]);
  const needed = needsSchedule(rules, watchlist, can('alerts', entitlements), can('watchlist', entitlements));
  const existing = await chrome.alarms.get(CHECK_ALARM);
  if (needed && !existing) {
    // The first run soon, so a new alert gets its baseline without waiting a full period.
    await chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 1, periodInMinutes: CHECK_PERIOD_MINUTES });
  } else if (!needed && existing) {
    await chrome.alarms.clear(CHECK_ALARM);
  }
  return needed;
}

export interface RunSummary {
  status: 'done' | 'skipped';
  reason?: 'plan' | 'nothing-to-check' | 'too-soon';
  checked: number;
  notified: number;
  problem: string | null;
}

let running: Promise<RunSummary> | null = null;

/** One check run. Concurrent calls share the run in progress. */
export function runChecks(trigger: 'alarm' | 'manual'): Promise<RunSummary> {
  running ??= doRun(trigger).finally(() => {
    running = null;
  });
  return running;
}

async function doRun(trigger: 'alarm' | 'manual'): Promise<RunSummary> {
  const entitlements = await currentEntitlements();
  const allowAlerts = can('alerts', entitlements);
  const allowWatchlist = can('watchlist', entitlements);
  if (!allowAlerts && !allowWatchlist) return { status: 'skipped', reason: 'plan', checked: 0, notified: 0, problem: null };

  const now = Date.now();
  const [allRules, allWatch, baselines, state] = await Promise.all([loadAlerts().catch(() => []), loadWatchlist().catch(() => []), loadBaselines(), loadMonitorState()]);
  if (trigger === 'manual' && state.lastRunAt !== null && now - state.lastRunAt < MIN_MANUAL_GAP_MS) {
    return { status: 'skipped', reason: 'too-soon', checked: 0, notified: 0, problem: state.lastProblem };
  }
  // Alerts kept while the plan doesn't include them are left untouched (paused), never deleted.
  const rules = allowAlerts ? allRules : [];
  const watchlist = allowWatchlist ? allWatch : [];
  const markets = marketsToCheck(rules, watchlist, state);
  if (!markets.length) return { status: 'skipped', reason: 'nothing-to-check', checked: 0, notified: 0, problem: null };

  const snapshots: MarketSnapshot[] = [];
  const events: { rule: AlertRule; event: AlertEvent; quote: string }[] = [];
  let problem: string | null = null;
  let checked = 0;

  for (const target of markets) {
    const key = marketKey(target);
    let result;
    try {
      result = await market.load(target.symbol, target.interval, { force: false });
    } catch {
      problem = 'Unexpected error while loading market data.';
      continue;
    }
    if (result.status !== 'fresh') {
      // Stale or missing data is never compared: a rule only fires on data fetched for this run.
      const error = result.error;
      problem = `${target.symbol} ${target.interval}: ${shortReason(error)}`;
      if (error.code === 'rate-limited') break; // Respect Retry-After: stop this run.
      continue;
    }
    const outcome = analyze(result.data.candles, { now: result.data.fetchedAt });
    if (!outcome.ok) continue;
    const current = toAlertSnapshot(target.symbol, target.interval, outcome.analysis, result.data.fetchedAt);
    const baseline = baselines[key] ?? null;
    for (const event of evaluateMarket(rules, baseline, current)) {
      const rule = rules.find((candidate) => candidate.id === event.ruleId);
      if (rule) events.push({ rule, event, quote: result.data.quote });
    }
    baselines[key] = { snapshot: current, recordedAt: now } satisfies Baseline;
    snapshots.push({ ...current, quote: result.data.quote, source: result.data.source });
    state.lastCheckedAt[key] = now;
    checked++;
  }

  for (const { rule, event, quote } of events) {
    const content = notificationFor(rule, event, quote);
    try {
      await chrome.notifications.create(notificationId(event), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: content.title,
        message: content.message,
        contextMessage: content.contextMessage,
        priority: 0,
      });
    } catch {
      // Notifications blocked by the OS or the user: the trigger is still recorded below.
    }
    state.triggers[rule.id] = { at: event.at, message: event.message };
  }

  // Keep only what still matters (deleted alerts, removed coins).
  const activeKeys = new Set([...allRules.map(marketKey), ...allWatch.map(marketKey)]);
  for (const key of Object.keys(baselines)) if (!activeKeys.has(key)) delete baselines[key];
  const next = pruneMonitorState({ ...state, lastRunAt: now, lastProblem: problem }, allRules, allWatch);
  await Promise.all([saveBaselines(baselines), saveMonitorState(next), recordSnapshots(snapshots)]);
  return { status: 'done', checked, notified: events.length, problem };
}

/** A click on an alert notification opens that market in the popup. */
export async function onNotificationClicked(id: string): Promise<void> {
  const target = parseNotificationId(id);
  chrome.notifications.clear(id).catch(() => undefined);
  if (!target) return;
  const state = await loadMonitorState();
  try {
    await setPendingAnalysis({ symbol: target.symbol, selection: '', interval: target.interval, alert: state.triggers[target.ruleId]?.message ?? null });
  } catch {
    // The popup still opens.
  }
  try {
    await chrome.action.openPopup();
  } catch {
    // No focused window (or Chrome < 127): open the same page in a tab instead.
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }).catch(() => undefined);
  }
}
