import { DEFAULT_ALERT_RULES, evaluateAlertRules, hasActiveAlerts, rulesFor, type AlertEvent, type AlertObservation, type AlertRule } from './alerts';
import { isFiniteNumber } from './numbers';
import { recordRefresh, type MarketSummary, type WatchItem } from './saved';

/**
 * Background alert checks (Pro), as pure functions. The service worker (src/background/alerts.ts)
 * wires them to chrome.alarms, the API and chrome.notifications.
 *
 * Budget: one alarm every ALERT_PERIOD_MINUTES; each run checks at most MAX_MARKETS_PER_CHECK
 * markets with alerts on, least recently checked first (so a long list rotates), skips markets
 * checked in the last MIN_RECHECK_MS (e.g. just refreshed in the popup), makes one market
 * request per market (through the same 60 s cache as the popup) and stops for a while after a
 * rate-limit answer.
 */

export const ALERT_ALARM = 'pm-ai:alerts';
export const ALERT_PERIOD_MINUTES = 15;
export const MAX_MARKETS_PER_CHECK = 10;
export const MIN_RECHECK_MS = 10 * 60 * 1000;
export const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;

export function observationOf(summary: MarketSummary | null): AlertObservation | null {
  return summary ? { probability: summary.probability, volume24h: summary.volume24h, signal: summary.signal, at: summary.at } : null;
}

/** Rules for the inline notes of a popup refresh: the market's own rules if set up, else the defaults. */
export function inlineRules(item: WatchItem): readonly AlertRule[] {
  return item.alertSettings.enabled ? rulesFor(item.alertSettings) : DEFAULT_ALERT_RULES;
}

/** The markets one background run checks. */
export function marketsToCheck(items: readonly WatchItem[], now: number, max: number = MAX_MARKETS_PER_CHECK, minRecheckMs: number = MIN_RECHECK_MS): WatchItem[] {
  return items
    .filter((item) => hasActiveAlerts(item.alertSettings))
    .filter((item) => !item.last || item.last.at > now || now - item.last.at >= minRecheckMs)
    .sort((a, b) => (a.last?.at ?? 0) - (b.last?.at ?? 0))
    .slice(0, Math.max(0, max));
}

/** True when any market has alerts on, i.e. the alarm should exist. */
export function needsAlarm(items: readonly WatchItem[]): boolean {
  return items.some((item) => hasActiveAlerts(item.alertSettings));
}

/** Records a background check on the stored item and returns the triggered alerts. */
export function applyCheck(item: WatchItem, summary: MarketSummary): { item: WatchItem; events: AlertEvent[] } {
  if (item.last && item.last.at >= summary.at) return { item, events: [] };
  const events = evaluateAlertRules(rulesFor(item.alertSettings), observationOf(item.last), observationOf(summary)!);
  return { item: recordRefresh(item, summary, events.map((event) => event.message)), events };
}

// --- Run state (shown on the options page) -------------------------------------------------

export interface AlertCheckState {
  lastRunAt: number | null;
  checked: number;
  notified: number;
  failed: number;
  /** No background requests before this time (after a rate-limit answer). */
  backoffUntil: number | null;
  lastError: string | null;
}

export const EMPTY_CHECK_STATE: AlertCheckState = { lastRunAt: null, checked: 0, notified: 0, failed: 0, backoffUntil: null, lastError: null };

export function sanitizeAlertCheckState(value: unknown): AlertCheckState {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const count = (entry: unknown) => (isFiniteNumber(entry) && entry >= 0 ? Math.min(Math.round(entry), 1000) : 0);
  const time = (entry: unknown) => (isFiniteNumber(entry) && entry > 0 ? entry : null);
  return {
    lastRunAt: time(raw.lastRunAt),
    checked: count(raw.checked),
    notified: count(raw.notified),
    failed: count(raw.failed),
    backoffUntil: time(raw.backoffUntil),
    lastError: typeof raw.lastError === 'string' && raw.lastError ? raw.lastError.slice(0, 200) : null,
  };
}

export function isBackingOff(state: AlertCheckState, now: number): boolean {
  return state.backoffUntil !== null && now < state.backoffUntil;
}

/** After a 429: wait at least RATE_LIMIT_BACKOFF_MS, longer if Polymarket asks for it. */
export function backoffAfterRateLimit(now: number, retryAfterSeconds?: number): number {
  const asked = isFiniteNumber(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds, 24 * 3600) * 1000 : 0;
  return now + Math.max(RATE_LIMIT_BACKOFF_MS, asked);
}

// --- Notifications -------------------------------------------------------------------------

export interface AlertNotification {
  title: string;
  message: string;
  contextMessage: string;
}

/** Words a notification must never contain: it reports numbers, it doesn't tell anyone to act. */
export const FORBIDDEN_NOTIFICATION_WORDS = /\b(buy|sell|bet|bets|betting|wager|profit|guaranteed?|opportunity|act now)\b/i;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The market title and the numbers, nothing else. */
export function alertNotification(item: WatchItem, events: readonly AlertEvent[]): AlertNotification {
  return {
    title: truncate(item.title, 90),
    message: events.map((event) => event.message).join('\n'),
    contextMessage: truncate(`${item.outcome} · Watchlist alert`, 60),
  };
}

const NOTIFICATION_PREFIX = 'pm-alert|';

export function notificationId(key: string, at: number): string {
  return `${NOTIFICATION_PREFIX}${key}|${at}`;
}

/** The watchlist key of an alert notification, or null for other ids. */
export function keyFromNotificationId(id: string): string | null {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return null;
  const rest = id.slice(NOTIFICATION_PREFIX.length);
  const end = rest.lastIndexOf('|');
  return end > 0 ? rest.slice(0, end) : null;
}
