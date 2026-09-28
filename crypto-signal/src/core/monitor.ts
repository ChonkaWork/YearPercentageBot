import { evaluateAlerts, sanitizeAlertSnapshot, type AlertEvent, type AlertRule, type AlertSnapshot } from './alerts';
import { isValidSymbol } from './assets';
import { asObject } from './sanitize';
import { isFiniteNumber, isInterval, isProviderId, type Interval, type ProviderId } from './types';

/**
 * Background checks, the pure part: which markets to check on a run, when a rule is ready to be
 * evaluated, and the stored state (watchlist, baselines, last snapshots) with its sanitizers.
 * The service worker (src/background/monitor.ts) does the fetching, storage and notifications.
 */

/** chrome.alarms period. Chrome allows 30 s and up; 15 min keeps requests far below any limit. */
export const CHECK_PERIOD_MINUTES = 15;
/** Most markets fetched in one run (least recently checked first); the rest wait for the next. */
export const MAX_MARKETS_PER_RUN = 12;
/** A manual "Check now" within this long of the last run is answered from the last run. */
export const MIN_MANUAL_GAP_MS = 30_000;

export interface Market {
  symbol: string;
  interval: Interval;
}

export function marketKey(market: Market): string {
  return `${market.symbol}:${market.interval}`;
}

// --- Watchlist ----------------------------------------------------------------------------

export interface WatchItem extends Market {
  addedAt: number;
}

export function sanitizeWatchlist(raw: unknown): WatchItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: WatchItem[] = [];
  for (const entry of raw) {
    const item = asObject(entry);
    if (!item || !isValidSymbol(item.symbol) || !isInterval(item.interval) || !isFiniteNumber(item.addedAt)) continue;
    const key = marketKey({ symbol: item.symbol, interval: item.interval });
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ symbol: item.symbol, interval: item.interval, addedAt: item.addedAt });
    if (items.length >= 50) break;
  }
  return items;
}

export type WatchResult = { ok: true; items: WatchItem[] } | { ok: false; error: string };

/** Adds a market (newest first). Never removes existing items to make room. */
export function addToWatchlist(items: readonly WatchItem[], market: Market, limit: number, now: number): WatchResult {
  if (limit <= 0) return { ok: false, error: 'The watchlist is part of Pro.' };
  if (items.some((item) => marketKey(item) === marketKey(market))) return { ok: false, error: `${market.symbol} ${market.interval} is already on your watchlist.` };
  if (items.length >= limit) return { ok: false, error: `Your watchlist holds ${limit} coins. Remove one to add another.` };
  return { ok: true, items: [{ symbol: market.symbol, interval: market.interval, addedAt: now }, ...items] };
}

export function removeFromWatchlist(items: readonly WatchItem[], market: Market): WatchItem[] {
  return items.filter((item) => marketKey(item) !== marketKey(market));
}

// --- Snapshots ----------------------------------------------------------------------------

/** The last known signal of a market, for the watchlist. */
export interface MarketSnapshot extends AlertSnapshot {
  quote: string;
  source: ProviderId;
}

export function sanitizeMarketSnapshot(raw: unknown): MarketSnapshot | null {
  const base = sanitizeAlertSnapshot(raw);
  const value = asObject(raw);
  if (!base || !value || typeof value.quote !== 'string' || !/^[A-Z]{3,5}$/.test(value.quote) || !isProviderId(value.source)) return null;
  return { ...base, quote: value.quote, source: value.source };
}

export const MAX_SNAPSHOTS = 64;

export function sanitizeSnapshotMap(raw: unknown): Record<string, MarketSnapshot> {
  const input = asObject(raw) ?? {};
  const out: Record<string, MarketSnapshot> = {};
  for (const [key, value] of Object.entries(input)) {
    const snapshot = sanitizeMarketSnapshot(value);
    if (snapshot && key === marketKey(snapshot)) out[key] = snapshot;
  }
  return out;
}

/** Stores a snapshot, keeping the newest MAX_SNAPSHOTS markets. */
export function putSnapshot(map: Readonly<Record<string, MarketSnapshot>>, snapshot: MarketSnapshot): Record<string, MarketSnapshot> {
  const key = marketKey(snapshot);
  const existing = map[key];
  if (existing && existing.at > snapshot.at) return { ...map };
  const entries = Object.entries({ ...map, [key]: snapshot }).sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_SNAPSHOTS));
}

// --- Baselines ----------------------------------------------------------------------------

/** What the background saw last for a market, and when it recorded it (wall clock). */
export interface Baseline {
  snapshot: AlertSnapshot;
  recordedAt: number;
}

export function sanitizeBaselines(raw: unknown): Record<string, Baseline> {
  const input = asObject(raw) ?? {};
  const out: Record<string, Baseline> = {};
  for (const [key, value] of Object.entries(input)) {
    const entry = asObject(value);
    const snapshot = sanitizeAlertSnapshot(entry?.snapshot);
    if (!entry || !snapshot || !isFiniteNumber(entry.recordedAt) || key !== marketKey(snapshot)) continue;
    out[key] = { snapshot, recordedAt: entry.recordedAt };
  }
  return out;
}

/**
 * A rule compares against a baseline recorded after it started watching (created or resumed).
 * Otherwise a change that happened before the alert existed, or while it was paused, would fire.
 */
export function isRuleReady(rule: AlertRule, baseline: Baseline | null): baseline is Baseline {
  return baseline !== null && baseline.recordedAt >= (rule.since ?? rule.createdAt);
}

/** Events for one market: only enabled rules for it that are ready. */
export function evaluateMarket(rules: readonly AlertRule[], baseline: Baseline | null, current: AlertSnapshot): AlertEvent[] {
  const ready = rules.filter((rule) => rule.enabled && rule.symbol === current.symbol && rule.interval === current.interval && isRuleReady(rule, baseline));
  return baseline ? evaluateAlerts(ready, baseline.snapshot, current) : [];
}

// --- Run planning -------------------------------------------------------------------------

export interface MonitorState {
  lastRunAt: number | null;
  /** marketKey → last time a check of it succeeded. */
  lastCheckedAt: Record<string, number>;
  /** ruleId → the last time it fired, with its message. */
  triggers: Record<string, { at: number; message: string }>;
  /** Short note about the last run ("Binance rate limited", …), or null when it went fine. */
  lastProblem: string | null;
}

export const EMPTY_MONITOR_STATE: Readonly<MonitorState> = Object.freeze({ lastRunAt: null, lastCheckedAt: {}, triggers: {}, lastProblem: null });

export function sanitizeMonitorState(raw: unknown): MonitorState {
  const input = asObject(raw);
  if (!input) return { lastRunAt: null, lastCheckedAt: {}, triggers: {}, lastProblem: null };
  const lastCheckedAt: Record<string, number> = {};
  for (const [key, value] of Object.entries(asObject(input.lastCheckedAt) ?? {})) if (isFiniteNumber(value)) lastCheckedAt[key] = value;
  const triggers: Record<string, { at: number; message: string }> = {};
  for (const [id, value] of Object.entries(asObject(input.triggers) ?? {})) {
    const trigger = asObject(value);
    if (trigger && isFiniteNumber(trigger.at) && typeof trigger.message === 'string') triggers[id] = { at: trigger.at, message: trigger.message.slice(0, 300) };
  }
  return {
    lastRunAt: isFiniteNumber(input.lastRunAt) ? input.lastRunAt : null,
    lastCheckedAt,
    triggers,
    lastProblem: typeof input.lastProblem === 'string' ? input.lastProblem.slice(0, 200) : null,
  };
}

/**
 * Markets for this run: those of enabled alerts and the watchlist, each once, least recently
 * checked first, at most `max`.
 */
export function marketsToCheck(rules: readonly AlertRule[], watchlist: readonly Market[], state: MonitorState, max: number = MAX_MARKETS_PER_RUN): Market[] {
  const markets = new Map<string, Market>();
  for (const rule of rules) if (rule.enabled) markets.set(marketKey(rule), { symbol: rule.symbol, interval: rule.interval });
  for (const item of watchlist) markets.set(marketKey(item), { symbol: item.symbol, interval: item.interval });
  return [...markets.entries()]
    .map(([key, market], order) => ({ market, last: state.lastCheckedAt[key] ?? -Infinity, order }))
    .sort((a, b) => a.last - b.last || a.order - b.order)
    .slice(0, Math.max(0, max))
    .map((entry) => entry.market);
}

/** Should the periodic alarm exist? */
export function needsSchedule(rules: readonly AlertRule[], watchlist: readonly Market[], allowAlerts: boolean, allowWatchlist: boolean): boolean {
  return (allowAlerts && rules.some((rule) => rule.enabled)) || (allowWatchlist && watchlist.length > 0);
}

/** Drops state for markets and rules that no longer exist, so storage doesn't grow forever. */
export function pruneMonitorState(state: MonitorState, rules: readonly AlertRule[], watchlist: readonly Market[]): MonitorState {
  const markets = new Set([...rules.map(marketKey), ...watchlist.map(marketKey)]);
  const ids = new Set(rules.map((rule) => rule.id));
  return {
    ...state,
    lastCheckedAt: Object.fromEntries(Object.entries(state.lastCheckedAt).filter(([key]) => markets.has(key))),
    triggers: Object.fromEntries(Object.entries(state.triggers).filter(([id]) => ids.has(id))),
  };
}
