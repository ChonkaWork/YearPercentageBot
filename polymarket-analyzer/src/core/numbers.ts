/**
 * Number guards. Everything the analysis engine consumes is either a finite number or null,
 * so NaN, Infinity and undefined can never reach the UI.
 */

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Finite number from a number or a numeric string (the Gamma API sends many numbers as
 * strings, e.g. `"liquidity": "12345.67"`). Anything else, including '', booleans and
 * 'NaN', becomes null.
 */
export function toFiniteNumber(value: unknown): number | null {
  if (isFiniteNumber(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Non-negative finite number (volumes, liquidity), else null. */
export function toNonNegative(value: unknown): number | null {
  const number = toFiniteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds away binary floating point noise (0.1 + 0.2) before comparing against thresholds. */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Probability change (0.052) to percentage points (5.2). */
export function toPp(change: number): number {
  return roundTo(change * 100, 6);
}

export function sign(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** Sample standard deviation; null for fewer than two values. */
export function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const result = Math.sqrt(variance);
  return Number.isFinite(result) ? result : null;
}
