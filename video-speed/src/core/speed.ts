/**
 * Speed arithmetic. Pure functions, no DOM.
 *
 * Speeds are kept on a 0.01 grid so repeated steps never drift (1.1 + 0.1 is 1.2, not
 * 1.2000000000000002), and clamped to the range Chrome accepts for `playbackRate`
 * (setting anything outside it throws).
 */

export const MIN_SPEED = 0.0625;
export const MAX_SPEED = 16;
export const DEFAULT_SPEED = 1;

/** Buttons shown in the popup. */
export const PRESET_SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Integer hundredths. `toFixed` first removes binary noise such as 1.005 * 100 = 100.49999. */
function toHundredths(value: number): number {
  return Math.round(Number((value * 100).toFixed(6)));
}

/** Rounds to 2 decimals without floating-point artifacts. */
export function roundSpeed(value: number): number {
  return toHundredths(value) / 100;
}

/** Rounds to 2 decimals and clamps into Chrome's supported range. Non-numbers become 1. */
export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPEED;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, roundSpeed(value)));
}

/** current ± delta, computed in hundredths. */
export function stepSpeed(current: number, delta: number): number {
  if (!Number.isFinite(current)) current = DEFAULT_SPEED;
  if (!Number.isFinite(delta)) delta = 0;
  return clampSpeed((toHundredths(current) + toHundredths(delta)) / 100);
}

/** Equal after rounding to the 0.01 grid. */
export function sameSpeed(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

/** G: go to the preferred speed, or back to 1× when already there. */
export function togglePreferred(current: number, preferred: number): number {
  const target = clampSpeed(preferred);
  return sameSpeed(roundSpeed(current), roundSpeed(target)) ? DEFAULT_SPEED : target;
}

/** Display form, always 2 decimals: 1.2 → "1.20". The minimum (0.0625) shows as "0.06". */
export function formatSpeed(speed: number): string {
  return `${roundSpeed(speed).toFixed(2)}×`;
}

/** Compact form for buttons: 1 → "1×", 1.25 → "1.25×". */
export function formatSpeedShort(speed: number): string {
  return `${roundSpeed(speed)}×`;
}

/** New playback position for rewind/advance, kept inside [0, duration]. */
export function seekTarget(current: number, delta: number, duration: number): number {
  const start = Number.isFinite(current) ? current : 0;
  let next = start + delta;
  if (Number.isFinite(duration) && duration >= 0) next = Math.min(next, duration);
  return Math.max(0, next);
}
