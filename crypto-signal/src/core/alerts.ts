import { isValidSymbol } from './assets';
import { formatNumber, formatPrice } from './format';
import { asObject } from './sanitize';
import { isSignalLabel, SIGNAL_LABELS, SIGNAL_TEXT, type Analysis, type SignalLabel } from './signal';
import { isFiniteNumber, isInterval, type Interval } from './types';

/**
 * Alert rules and their evaluation (pure; the service worker schedules the checks, see
 * src/background/monitor.ts). A rule is evaluated by comparing two consecutive analyses of the
 * same market. Every condition is edge-triggered: it fires when it becomes true, not on every
 * check while it stays true, and never without a previous analysis to compare with.
 *
 * Honesty: alerts describe indicator events ("RSI crossed above 70", "signal is now Bearish").
 * They never say buy or sell and never predict a move.
 */

export type AlertCondition =
  /** The signal label changed (e.g. NEUTRAL → BULLISH). */
  | { type: 'signal-changed' }
  /** The signal became one of these labels. */
  | { type: 'signal-becomes'; signals: readonly SignalLabel[] }
  /** Signal strength rose to at least this percentage. */
  | { type: 'strength-at-least'; strength: number }
  /** RSI crossed a level. */
  | { type: 'rsi-crosses'; level: number; direction: 'above' | 'below' }
  /** Price crossed a level. */
  | { type: 'price-crosses'; price: number; direction: 'above' | 'below' };

export interface AlertRule {
  id: string;
  symbol: string;
  interval: Interval;
  condition: AlertCondition;
  enabled: boolean;
  createdAt: number;
  /** When the rule started watching (creation, or the last resume). Defaults to createdAt. */
  since?: number;
}

/** The few numbers of an analysis that rules look at. */
export interface AlertSnapshot {
  symbol: string;
  interval: Interval;
  signal: SignalLabel;
  strength: number;
  price: number;
  rsi: number;
  at: number;
}

export interface AlertEvent {
  ruleId: string;
  symbol: string;
  interval: Interval;
  message: string;
  at: number;
}

export function toAlertSnapshot(symbol: string, interval: Interval, analysis: Analysis, at: number): AlertSnapshot {
  return {
    symbol,
    interval,
    signal: analysis.signal,
    strength: analysis.strength,
    price: analysis.price,
    rsi: analysis.indicators.rsi.value,
    at,
  };
}

export function evaluateAlert(rule: AlertRule, previous: AlertSnapshot | null, current: AlertSnapshot): AlertEvent | null {
  if (!rule.enabled || !previous) return null;
  if (!sameMarket(rule, current) || !sameMarket(rule, previous)) return null;
  if (current.at <= previous.at) return null;

  const fired = (message: string): AlertEvent => ({
    ruleId: rule.id,
    symbol: rule.symbol,
    interval: rule.interval,
    message,
    at: current.at,
  });
  const market = `${rule.symbol} (${rule.interval})`;
  const condition = rule.condition;

  switch (condition.type) {
    case 'signal-changed':
      return previous.signal !== current.signal
        ? fired(`${market} signal changed from ${SIGNAL_TEXT[previous.signal]} to ${SIGNAL_TEXT[current.signal]}.`)
        : null;
    case 'signal-becomes':
      return condition.signals.includes(current.signal) && !condition.signals.includes(previous.signal)
        ? fired(`${market} signal is now ${SIGNAL_TEXT[current.signal]}.`)
        : null;
    case 'strength-at-least':
      return current.strength >= condition.strength && previous.strength < condition.strength
        ? fired(`${market} signal strength reached ${current.strength}% (${SIGNAL_TEXT[current.signal]}).`)
        : null;
    case 'rsi-crosses':
      return crossed(previous.rsi, current.rsi, condition.level, condition.direction)
        ? fired(`${market} RSI crossed ${condition.direction} ${formatNumber(condition.level, 0)} (now ${formatNumber(current.rsi, 1)}).`)
        : null;
    case 'price-crosses':
      return crossed(previous.price, current.price, condition.price, condition.direction)
        ? fired(`${market} price crossed ${condition.direction} ${formatPrice(condition.price)} (now ${formatPrice(current.price)}).`)
        : null;
  }
}

/** Evaluates many rules against the same pair of analyses. */
export function evaluateAlerts(rules: readonly AlertRule[], previous: AlertSnapshot | null, current: AlertSnapshot): AlertEvent[] {
  return rules.map((rule) => evaluateAlert(rule, previous, current)).filter((event): event is AlertEvent => event !== null);
}

function crossed(before: number, after: number, level: number, direction: 'above' | 'below'): boolean {
  if (![before, after, level].every(Number.isFinite)) return false;
  return direction === 'above' ? before < level && after >= level : before > level && after <= level;
}

function sameMarket(rule: AlertRule, snapshot: AlertSnapshot): boolean {
  return rule.symbol === snapshot.symbol && rule.interval === snapshot.interval;
}

// --- Building rules from the popup form ---------------------------------------------------

/** The choices the popup offers. Each maps to one AlertCondition. */
export const ALERT_CHOICES = [
  'signal-changed',
  'turns-bullish',
  'turns-strong-bullish',
  'turns-neutral',
  'turns-bearish',
  'turns-strong-bearish',
  'rsi-above',
  'rsi-below',
  'price-above',
  'price-below',
] as const;
export type AlertChoice = (typeof ALERT_CHOICES)[number];

export const ALERT_CHOICE_TEXT: Readonly<Record<AlertChoice, string>> = Object.freeze({
  'signal-changed': 'Signal changes',
  'turns-bullish': 'Signal turns bullish',
  'turns-strong-bullish': 'Signal turns strongly bullish',
  'turns-neutral': 'Signal turns neutral',
  'turns-bearish': 'Signal turns bearish',
  'turns-strong-bearish': 'Signal turns strongly bearish',
  'rsi-above': 'RSI crosses above',
  'rsi-below': 'RSI crosses below',
  'price-above': 'Price crosses above',
  'price-below': 'Price crosses below',
});

const SIGNAL_GROUPS: Readonly<Record<string, readonly SignalLabel[]>> = Object.freeze({
  'turns-bullish': ['BULLISH', 'STRONG_BULLISH'],
  'turns-strong-bullish': ['STRONG_BULLISH'],
  'turns-neutral': ['NEUTRAL'],
  'turns-bearish': ['BEARISH', 'STRONG_BEARISH'],
  'turns-strong-bearish': ['STRONG_BEARISH'],
});

export function isAlertChoice(value: unknown): value is AlertChoice {
  return typeof value === 'string' && (ALERT_CHOICES as readonly string[]).includes(value);
}

/** Does this choice need a number (RSI level or price)? */
export function choiceNeedsLevel(choice: AlertChoice): 'rsi' | 'price' | null {
  if (choice === 'rsi-above' || choice === 'rsi-below') return 'rsi';
  if (choice === 'price-above' || choice === 'price-below') return 'price';
  return null;
}

/** A sensible starting value for the level field. */
export function defaultLevel(choice: AlertChoice, currentPrice: number | null): number | null {
  if (choice === 'rsi-above') return 70;
  if (choice === 'rsi-below') return 30;
  if (choiceNeedsLevel(choice) === 'price' && currentPrice !== null && Number.isFinite(currentPrice) && currentPrice > 0) {
    return roundPrice(currentPrice * (choice === 'price-above' ? 1.05 : 0.95));
  }
  return null;
}

/** Rounds to about three significant digits (64,231 → 67,400; 0.4512 → 0.474). */
export function roundPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(value)) - 2);
  return Number((Math.round(value / step) * step).toPrecision(12));
}

export function conditionFromChoice(choice: AlertChoice, level: number | null): AlertCondition {
  switch (choice) {
    case 'signal-changed':
      return { type: 'signal-changed' };
    case 'rsi-above':
    case 'rsi-below':
      return { type: 'rsi-crosses', level: level ?? Number.NaN, direction: choice === 'rsi-above' ? 'above' : 'below' };
    case 'price-above':
    case 'price-below':
      return { type: 'price-crosses', price: level ?? Number.NaN, direction: choice === 'price-above' ? 'above' : 'below' };
    default:
      return { type: 'signal-becomes', signals: SIGNAL_GROUPS[choice]! };
  }
}

/** "Signal turns bearish", "RSI crosses above 70", "Price crosses below 60,000.00". */
export function describeCondition(condition: AlertCondition): string {
  switch (condition.type) {
    case 'signal-changed':
      return 'Signal changes';
    case 'signal-becomes': {
      const choice = Object.entries(SIGNAL_GROUPS).find(([, group]) => sameLabels(group, condition.signals))?.[0];
      if (choice) return ALERT_CHOICE_TEXT[choice as AlertChoice];
      return `Signal becomes ${condition.signals.map((label) => SIGNAL_TEXT[label]).join(' or ')}`;
    }
    case 'strength-at-least':
      return `Signal strength reaches ${formatNumber(condition.strength, 0)}%`;
    case 'rsi-crosses':
      return `RSI crosses ${condition.direction} ${formatNumber(condition.level, condition.level % 1 ? 1 : 0)}`;
    case 'price-crosses':
      return `Price crosses ${condition.direction} ${formatPrice(condition.price)}`;
  }
}

function sameLabels(a: readonly SignalLabel[], b: readonly SignalLabel[]): boolean {
  return a.length === b.length && a.every((label) => b.includes(label));
}

export interface NewAlertInput {
  symbol: string;
  interval: Interval;
  choice: AlertChoice;
  /** RSI level or price, for the choices that need one. */
  level: number | null;
}

export type NewAlertResult = { ok: true; rule: AlertRule } | { ok: false; error: string };

/**
 * Validates the popup form and builds a rule. `limit` is the plan's alert limit
 * (features.alertLimit); existing alerts are never removed to make room.
 */
export function createAlertRule(input: NewAlertInput, existing: readonly AlertRule[], limit: number, id: string, now: number): NewAlertResult {
  if (limit <= 0) return { ok: false, error: 'Background alerts are part of Pro.' };
  if (existing.length >= limit) return { ok: false, error: `You have ${existing.length} of ${limit} alerts. Delete one to add another.` };
  if (!isValidSymbol(input.symbol) || !isInterval(input.interval)) return { ok: false, error: 'Choose a coin and timeframe first.' };
  const needs = choiceNeedsLevel(input.choice);
  if (needs === 'rsi' && !(isFiniteNumber(input.level) && input.level > 0 && input.level < 100)) {
    return { ok: false, error: 'Enter an RSI level between 1 and 99.' };
  }
  if (needs === 'price' && !(isFiniteNumber(input.level) && input.level > 0 && input.level < 1e9)) {
    return { ok: false, error: 'Enter a price above 0.' };
  }
  const condition = conditionFromChoice(input.choice, needs ? input.level : null);
  const rule: AlertRule = { id, symbol: input.symbol, interval: input.interval, condition, enabled: true, createdAt: now };
  if (existing.some((other) => sameRule(other, rule))) return { ok: false, error: 'You already have this alert.' };
  return { ok: true, rule };
}

function sameRule(a: AlertRule, b: AlertRule): boolean {
  return a.symbol === b.symbol && a.interval === b.interval && JSON.stringify(a.condition) === JSON.stringify(b.condition);
}

// --- Storage sanitizers -------------------------------------------------------------------

export const MAX_STORED_ALERTS = 50;

export function sanitizeCondition(raw: unknown): AlertCondition | null {
  const c = asObject(raw);
  if (!c) return null;
  const direction = c.direction === 'above' || c.direction === 'below' ? c.direction : null;
  switch (c.type) {
    case 'signal-changed':
      return { type: 'signal-changed' };
    case 'signal-becomes': {
      if (!Array.isArray(c.signals)) return null;
      const signals = SIGNAL_LABELS.filter((label) => (c.signals as unknown[]).includes(label));
      return signals.length ? { type: 'signal-becomes', signals } : null;
    }
    case 'strength-at-least':
      return isFiniteNumber(c.strength) && c.strength > 0 && c.strength <= 100 ? { type: 'strength-at-least', strength: c.strength } : null;
    case 'rsi-crosses':
      return direction && isFiniteNumber(c.level) && c.level > 0 && c.level < 100 ? { type: 'rsi-crosses', level: c.level, direction } : null;
    case 'price-crosses':
      return direction && isFiniteNumber(c.price) && c.price > 0 ? { type: 'price-crosses', price: c.price, direction } : null;
    default:
      return null;
  }
}

export function sanitizeAlertRule(raw: unknown): AlertRule | null {
  const r = asObject(raw);
  if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 64) return null;
  if (!isValidSymbol(r.symbol) || !isInterval(r.interval) || typeof r.enabled !== 'boolean' || !isFiniteNumber(r.createdAt)) return null;
  const condition = sanitizeCondition(r.condition);
  if (!condition) return null;
  const rule: AlertRule = { id: r.id, symbol: r.symbol, interval: r.interval, condition, enabled: r.enabled, createdAt: r.createdAt };
  if (isFiniteNumber(r.since) && r.since >= r.createdAt) rule.since = r.since;
  return rule;
}

export function sanitizeAlertRules(raw: unknown): AlertRule[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const rules: AlertRule[] = [];
  for (const item of raw) {
    const rule = sanitizeAlertRule(item);
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);
    rules.push(rule);
    if (rules.length >= MAX_STORED_ALERTS) break;
  }
  return rules;
}

export function sanitizeAlertSnapshot(raw: unknown): AlertSnapshot | null {
  const s = asObject(raw);
  if (!s || !isValidSymbol(s.symbol) || !isInterval(s.interval) || !isSignalLabel(s.signal)) return null;
  const { strength, price, rsi, at } = s;
  if (!isFiniteNumber(strength) || strength < 0 || strength > 100) return null;
  if (!isFiniteNumber(price) || price <= 0 || !isFiniteNumber(rsi) || rsi < 0 || rsi > 100 || !isFiniteNumber(at)) return null;
  return { symbol: s.symbol, interval: s.interval, signal: s.signal, strength, price, rsi, at };
}

// --- Notification text ---------------------------------------------------------------------

/** Shown under every alert notification. */
export const ALERT_CONTEXT = 'Technical indicator event · not financial advice';

export interface AlertNotification {
  title: string;
  message: string;
  contextMessage: string;
}

/** Notification copy for a fired alert: the rule it matched and what the indicators did. */
export function notificationFor(rule: AlertRule, event: AlertEvent, quote: string | null): AlertNotification {
  const pair = quote ? `${rule.symbol}/${quote}` : rule.symbol;
  return {
    title: `${pair} ${rule.interval} · ${describeCondition(rule.condition)}`,
    message: event.message,
    contextMessage: ALERT_CONTEXT,
  };
}

const NOTIFICATION_PREFIX = 'cs-alert';

/** Notification ids carry the market, so a click can open it even after the worker restarted. */
export function notificationId(event: AlertEvent): string {
  return [NOTIFICATION_PREFIX, event.symbol, event.interval, event.ruleId, String(event.at)].join('|');
}

export function parseNotificationId(id: string): { symbol: string; interval: Interval; ruleId: string } | null {
  const [prefix, symbol, interval, ruleId] = id.split('|');
  if (prefix !== NOTIFICATION_PREFIX || !isValidSymbol(symbol) || !isInterval(interval) || !ruleId) return null;
  return { symbol, interval, ruleId };
}
