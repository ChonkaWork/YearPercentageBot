import {
  ALERT_ALARM,
  ALERT_PERIOD_MINUTES,
  alertNotification,
  applyCheck,
  backoffAfterRateLimit,
  isBackingOff,
  keyFromNotificationId,
  marketsToCheck,
  needsAlarm,
  notificationId,
} from '../core/alertCheck';
import type { AlertEvent } from '../core/alerts';
import { analyzeMarket } from '../core/analyze';
import { effectivePlan, hasFeature } from '../core/plan';
import { summarize, type WatchItem } from '../core/saved';
import { marketPageUrl, refFromKey } from '../core/slug';
import { API, CACHE_TTL_MS, MAX_STALE_MS } from '../config';
import { TtlCache } from '../data/cache';
import { describeError, isDataError } from '../data/errors';
import { PolymarketService } from '../data/polymarketService';
import { loadAlertCheckState, loadEarlyAccess, loadPlan, loadWatchlist, saveAlertCheckState, SessionCacheBackend, updateWatchItem } from '../storage/store';
import { handOffToPopup } from './popup';

/**
 * Background alerts (Pro): a chrome.alarms schedule checks watchlist markets that have alerts
 * switched on and shows a chrome.notifications notification with the market title and the
 * numbers. Scheduling, budgets and texts are in src/core/alertCheck.ts (pure, unit-tested).
 */

// Same API origins and the same session cache as the popup, so a market the popup fetched
// within the last 60 s isn't requested again.
const service = new PolymarketService({
  gammaBase: API.gammaBase,
  clobBase: API.clobBase,
  fetch: (input, init) => fetch(input, init),
  cache: new TtlCache(new SessionCacheBackend(MAX_STALE_MS), { ttlMs: CACHE_TTL_MS, maxStaleMs: MAX_STALE_MS }),
});

async function alertsAllowed(): Promise<boolean> {
  return hasFeature(effectivePlan(await loadPlan(), await loadEarlyAccess()), 'alerts');
}

/** Creates the alarm when some market has alerts on (and the plan allows it), removes it otherwise. */
export async function syncAlarm(): Promise<boolean> {
  const wanted = (await alertsAllowed()) && needsAlarm(await loadWatchlist());
  const existing = await chrome.alarms.get(ALERT_ALARM);
  // An existing alarm is kept as is, so editing settings doesn't postpone the next check.
  if (wanted && !existing) await chrome.alarms.create(ALERT_ALARM, { delayInMinutes: ALERT_PERIOD_MINUTES, periodInMinutes: ALERT_PERIOD_MINUTES });
  if (!wanted && existing) await chrome.alarms.clear(ALERT_ALARM);
  return wanted;
}

export interface RunResult {
  status: 'done' | 'not-allowed' | 'backing-off';
  checked: number;
  notified: number;
  failed: number;
}

let running: Promise<RunResult> | null = null;

/** One background check. Overlapping calls share the run in progress. */
export function runAlertCheck(): Promise<RunResult> {
  running ??= checkNow().finally(() => {
    running = null;
  });
  return running;
}

async function checkNow(): Promise<RunResult> {
  if (!(await alertsAllowed())) {
    await syncAlarm();
    return { status: 'not-allowed', checked: 0, notified: 0, failed: 0 };
  }
  const startedAt = Date.now();
  const previous = await loadAlertCheckState();
  if (isBackingOff(previous, startedAt)) return { status: 'backing-off', checked: 0, notified: 0, failed: 0 };

  let checked = 0;
  let notified = 0;
  let failed = 0;
  let lastError: string | null = null;
  let backoffUntil: number | null = null;
  // One market at a time: at most MAX_MARKETS_PER_CHECK requests per run, spread out.
  for (const item of marketsToCheck(await loadWatchlist(), startedAt)) {
    try {
      const context = await service.getCurrentMarket(item.ref);
      // Cached data served because the refresh failed is not a new observation.
      if (context.stale) throw context.error ?? new Error('Stale data');
      const summary = summarize(analyzeMarket({ market: context.data.market, history: null, now: Date.now() }), context.fetchedAt);
      let result: { item: WatchItem; events: AlertEvent[] } | null = null;
      await updateWatchItem(item.key, (stored) => {
        result = applyCheck(stored, summary);
        return result.item;
      });
      checked++;
      const { item: updated, events } = (result ?? { item, events: [] }) as { item: WatchItem; events: AlertEvent[] };
      if (events.length && (await notify(updated, events))) notified++;
    } catch (error) {
      failed++;
      lastError = describeError(error).title;
      if (isDataError(error) && error.code === 'RATE_LIMITED') {
        backoffUntil = backoffAfterRateLimit(Date.now(), error.details.retryAfterSeconds);
        break;
      }
    }
  }
  await saveAlertCheckState({ lastRunAt: startedAt, checked, notified, failed, backoffUntil, lastError }).catch(() => undefined);
  return { status: 'done', checked, notified, failed };
}

async function notify(item: WatchItem, events: readonly AlertEvent[]): Promise<boolean> {
  const content = alertNotification(item, events);
  try {
    await chrome.notifications.create(notificationId(item.key, item.last?.at ?? Date.now()), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: content.title,
      message: content.message,
      contextMessage: content.contextMessage,
      priority: 0,
    });
    return true;
  } catch {
    // Notifications blocked at the OS level: the alert is still on the watchlist item.
    return false;
  }
}

/** A click on an alert notification opens the popup with that market's analysis. */
export async function onNotificationClicked(id: string): Promise<void> {
  const key = keyFromNotificationId(id);
  if (!key) return;
  await chrome.notifications.clear(id).catch(() => false);
  const item = (await loadWatchlist()).find((entry) => entry.key === key);
  const ref = item?.ref ?? refFromKey(key);
  if (ref) await handOffToPopup(undefined, { kind: 'analyze', url: marketPageUrl(ref) });
}
