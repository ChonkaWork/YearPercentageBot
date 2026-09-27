import { isFiniteNumber, toPp } from './numbers';

/**
 * Display formatting. Every formatter accepts null (unknown) and returns an em dash for it,
 * so the UI never shows NaN, Infinity or "undefined".
 */

export const MISSING = '—';
const MINUS = '−';

/** 0.624 -> "62.4%". Extremes are shown as "<0.1%" / ">99.9%" rather than a misleading 0% or 100%. */
export function formatProbability(value: number | null | undefined, digits = 1): string {
  if (!isFiniteNumber(value)) return MISSING;
  if (value <= 0) return '0%';
  if (value >= 1) return '100%';
  const floor = 10 ** -digits / 100;
  if (value < floor) return `<${(floor * 100).toFixed(digits)}%`;
  if (value > 1 - floor) return `>${(100 - floor * 100).toFixed(digits)}%`;
  return `${(value * 100).toFixed(digits)}%`;
}

/** Probability change in percentage points: 0.062 -> "+6.2 pp", -0.031 -> "−3.1 pp". */
export function formatPp(change: number | null | undefined, options: { unit?: boolean; digits?: number } = {}): string {
  if (!isFiniteNumber(change)) return MISSING;
  const digits = options.digits ?? 1;
  const pp = toPp(change);
  const rounded = Number(pp.toFixed(digits));
  const body = Math.abs(rounded).toFixed(digits);
  const signed = rounded > 0 ? `+${body}` : rounded < 0 ? `${MINUS}${body}` : body;
  return options.unit === false ? signed : `${signed} pp`;
}

/** Size of a change without its sign: -0.031 -> "3.1 pp". */
export function formatPpMagnitude(change: number | null | undefined, digits = 1): string {
  if (!isFiniteNumber(change)) return MISSING;
  return `${Math.abs(toPp(change)).toFixed(digits)} pp`;
}

/** Direction of a change for colouring, after rounding to what is displayed (0.1 pp). */
export function changeDirection(change: number | null | undefined): 'up' | 'down' | 'flat' {
  if (!isFiniteNumber(change)) return 'flat';
  const rounded = Number(toPp(change).toFixed(1));
  return rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
}

/** Compact USD: 845 -> "$845", 12_400 -> "$12.4K", 1_250_000 -> "$1.25M". */
export function formatUsd(value: number | null | undefined): string {
  if (!isFiniteNumber(value) || value < 0) return MISSING;
  if (value < 1000) return `$${Math.round(value).toLocaleString('en-US')}`;
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (let index = units.length - 1; index >= 0; index--) {
    const [size, suffix] = units[index]!;
    const next = units[index - 1];
    // Walk up from K so that 999_999 becomes "$1M", not "$1000K".
    if (next && value >= next[0] * 0.9995) continue;
    const scaled = value / size;
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `$${Number(scaled.toFixed(digits)).toString()}${suffix}`;
  }
  return `$${Math.round(value)}`;
}

/** 2.14 -> "2.1×". */
export function formatRatio(value: number | null | undefined): string {
  if (!isFiniteNumber(value) || value < 0) return MISSING;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}×`;
}

export function formatDate(timestamp: number | null | undefined): string {
  if (!isFiniteNumber(timestamp)) return MISSING;
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(timestamp: number | null | undefined): string {
  if (!isFiniteNumber(timestamp)) return MISSING;
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatClock(timestamp: number | null | undefined): string {
  if (!isFiniteNumber(timestamp)) return MISSING;
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function relativeTime(timestamp: number | null | undefined, now: number = Date.now()): string {
  if (!isFiniteNumber(timestamp)) return MISSING;
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** "3 markets" / "1 market". */
export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}
