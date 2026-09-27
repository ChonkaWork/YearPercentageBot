import { formatNumber, formatPrice } from './format';
import { SIGNAL_TEXT, type Analysis, type SignalLabel } from './signal';
import type { Interval } from './types';

/**
 * Alerts: architecture only in the MVP (no background polling yet). A rule is evaluated by
 * comparing two consecutive analyses of the same market. Every condition is edge-triggered:
 * it fires when it becomes true, not on every check while it stays true, and never without a
 * previous analysis to compare with.
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
