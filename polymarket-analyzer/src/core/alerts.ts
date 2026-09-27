import { formatPp, formatProbability } from './format';
import { SIGNAL_TEXT, signalDirection, type SignalLabel } from './momentum';
import { isFiniteNumber, toPp } from './numbers';

/**
 * Alert rules, evaluated between two observations of the same market (for example the
 * previous and the current watchlist refresh). The MVP evaluates them in the popup when the
 * watchlist is refreshed and shows the result inline. There are no background checks and no
 * notifications; an `AlertService` implementation could add that later without changing rules.
 */

export type AlertRule =
  | { id: string; kind: 'probability-move'; thresholdPp: number }
  | { id: string; kind: 'volume-increase'; thresholdPct: number }
  | { id: string; kind: 'momentum-flip' };

export interface AlertObservation {
  probability: number | null;
  volume24h: number | null;
  signal: SignalLabel | null;
  at: number;
}

export interface AlertEvent {
  ruleId: string;
  kind: AlertRule['kind'];
  message: string;
}

export const DEFAULT_ALERT_RULES: readonly AlertRule[] = [
  { id: 'move-5pp', kind: 'probability-move', thresholdPp: 5 },
  { id: 'volume-100pct', kind: 'volume-increase', thresholdPct: 100 },
  { id: 'momentum-flip', kind: 'momentum-flip' },
];

export function evaluateAlertRule(rule: AlertRule, previous: AlertObservation, current: AlertObservation): AlertEvent | null {
  switch (rule.kind) {
    case 'probability-move': {
      if (!isFiniteNumber(previous.probability) || !isFiniteNumber(current.probability)) return null;
      const change = current.probability - previous.probability;
      if (Math.abs(toPp(change)) <= rule.thresholdPp) return null;
      return {
        ruleId: rule.id,
        kind: rule.kind,
        message: `Moved ${formatPp(change)} since last check (${formatProbability(previous.probability)} → ${formatProbability(current.probability)})`,
      };
    }
    case 'volume-increase': {
      if (!isFiniteNumber(previous.volume24h) || !isFiniteNumber(current.volume24h) || previous.volume24h <= 0) return null;
      const increasePct = ((current.volume24h - previous.volume24h) / previous.volume24h) * 100;
      if (increasePct <= rule.thresholdPct) return null;
      return { ruleId: rule.id, kind: rule.kind, message: `24h volume up ${Math.round(increasePct)}% since last check` };
    }
    case 'momentum-flip': {
      const before = signalDirection(previous.signal);
      const after = signalDirection(current.signal);
      if (before === 'flat' || after === 'flat' || before === after || !current.signal) return null;
      return { ruleId: rule.id, kind: rule.kind, message: `Momentum flipped to ${SIGNAL_TEXT[current.signal].toLowerCase()}` };
    }
  }
}

export function evaluateAlertRules(rules: readonly AlertRule[], previous: AlertObservation | null, current: AlertObservation): AlertEvent[] {
  if (!previous) return [];
  return rules.map((rule) => evaluateAlertRule(rule, previous, current)).filter((event): event is AlertEvent => event !== null);
}

export interface AlertService {
  rules(): readonly AlertRule[];
  evaluate(previous: AlertObservation | null, current: AlertObservation): AlertEvent[];
}

export class LocalAlertService implements AlertService {
  constructor(private readonly ruleSet: readonly AlertRule[] = DEFAULT_ALERT_RULES) {}

  rules(): readonly AlertRule[] {
    return this.ruleSet;
  }

  evaluate(previous: AlertObservation | null, current: AlertObservation): AlertEvent[] {
    return evaluateAlertRules(this.ruleSet, previous, current);
  }
}
