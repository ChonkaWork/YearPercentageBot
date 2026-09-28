import { formatPp, formatProbability } from './format';
import { SIGNAL_TEXT, signalDirection, type SignalLabel } from './momentum';
import { isFiniteNumber, toPp } from './numbers';

/**
 * Alert rules, evaluated between two observations of the same market: the previous and the
 * current check (a watchlist refresh in the popup, or a background check). The popup shows the
 * result inline on the watchlist item; the background alert check (Pro, per-market settings
 * below) also shows a notification. See src/core/alertCheck.ts for the scheduling logic.
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

// --- Per-market alert settings ------------------------------------------------------------

/** Background alert settings of one watchlist market. A `null` threshold turns that rule off. */
export interface AlertSettings {
  enabled: boolean;
  movePp: number | null;
  volumePct: number | null;
  momentumFlip: boolean;
}

export const ALERT_BOUNDS = {
  movePp: { min: 0.5, max: 50, step: 0.5 },
  volumePct: { min: 10, max: 1000, step: 10 },
} as const;

/** Defaults when alerts are switched on for a market: the same rules as DEFAULT_ALERT_RULES. */
export const DEFAULT_ALERT_SETTINGS: AlertSettings = { enabled: false, movePp: 5, volumePct: 100, momentumFlip: true };

function clampThreshold(value: unknown, bounds: { min: number; max: number; step: number }, fallback: number | null): number | null {
  if (value === null) return null;
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!isFiniteNumber(number)) return fallback;
  const stepped = Math.round(number / bounds.step) * bounds.step;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(stepped * 100) / 100));
}

/** Stored settings are read back through this: anything odd becomes the default or is clamped. */
export function sanitizeAlertSettings(value: unknown): AlertSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    enabled: raw.enabled === true,
    movePp: 'movePp' in raw ? clampThreshold(raw.movePp, ALERT_BOUNDS.movePp, DEFAULT_ALERT_SETTINGS.movePp) : DEFAULT_ALERT_SETTINGS.movePp,
    volumePct: 'volumePct' in raw ? clampThreshold(raw.volumePct, ALERT_BOUNDS.volumePct, DEFAULT_ALERT_SETTINGS.volumePct) : DEFAULT_ALERT_SETTINGS.volumePct,
    momentumFlip: typeof raw.momentumFlip === 'boolean' ? raw.momentumFlip : DEFAULT_ALERT_SETTINGS.momentumFlip,
  };
}

/** The rules a market's settings stand for (whether or not background alerts are enabled). */
export function rulesFor(settings: AlertSettings): AlertRule[] {
  const rules: AlertRule[] = [];
  if (settings.movePp !== null) rules.push({ id: `move-${settings.movePp}pp`, kind: 'probability-move', thresholdPp: settings.movePp });
  if (settings.volumePct !== null) rules.push({ id: `volume-${settings.volumePct}pct`, kind: 'volume-increase', thresholdPct: settings.volumePct });
  if (settings.momentumFlip) rules.push({ id: 'momentum-flip', kind: 'momentum-flip' });
  return rules;
}

/** True when enabled and at least one rule is on. */
export function hasActiveAlerts(settings: AlertSettings): boolean {
  return settings.enabled && rulesFor(settings).length > 0;
}

/** One-line description, e.g. "Move > 5 pp · Volume > +100% · Momentum flip". */
export function describeAlertSettings(settings: AlertSettings): string {
  const parts = [
    settings.movePp !== null ? `Move > ${settings.movePp} pp` : null,
    settings.volumePct !== null ? `Volume > +${settings.volumePct}%` : null,
    settings.momentumFlip ? 'Momentum flip' : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No rules selected';
}
