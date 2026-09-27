export const MINUTE_MS = 60_000;
/** Backoff never waits longer than this (unless the interval itself is longer). */
export const MAX_BACKOFF_MS = 24 * 60 * MINUTE_MS;
/** Checks are spread by ±10% so watches added together don't fire together. */
export const JITTER_RATIO = 0.1;
/** Chrome doesn't fire alarms sooner than ~30 s anyway. */
export const MIN_DELAY_MS = MINUTE_MS;

/**
 * Time until the next check: the watch's interval, doubled for each consecutive failed check
 * (capped at a day), at least as long as a Retry-After the site sent, with ±10% jitter.
 */
export function nextCheckDelay(
  intervalMinutes: number,
  errorCount: number,
  random: () => number,
  retryAfterSeconds?: number,
): number {
  const base = intervalMinutes * MINUTE_MS;
  const factor = errorCount > 0 ? 2 ** Math.min(errorCount - 1, 12) : 1;
  let delay = Math.min(base * factor, Math.max(base, MAX_BACKOFF_MS));
  if (retryAfterSeconds && retryAfterSeconds > 0) delay = Math.max(delay, Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS));
  const jitter = delay * JITTER_RATIO * (random() * 2 - 1);
  return Math.max(MIN_DELAY_MS, Math.round(delay + jitter));
}

/**
 * When checks are overdue (the browser was closed), don't fire them all at once:
 * spread them over the next few minutes.
 */
export function catchUpDelay(random: () => number, index: number): number {
  return MIN_DELAY_MS + index * 20_000 + Math.round(random() * 2 * MINUTE_MS);
}
