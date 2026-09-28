/**
 * The current time. In production this is just Date.now(). The e2e build can shift it through
 * a storage key, so schedules and pauses are tested without waiting (compiled out of dist/).
 */

const E2E_CLOCK_KEY = __E2E__ ? 'e2e:clockOffset' : '';
let offset = 0;

export function now(): number {
  return Date.now() + offset;
}

/** Loads the e2e offset (no-op in production). */
export async function initClock(): Promise<void> {
  if (!__E2E__) return;
  const data = await chrome.storage.local.get(E2E_CLOCK_KEY);
  offset = typeof data[E2E_CLOCK_KEY] === 'number' ? data[E2E_CLOCK_KEY] : 0;
}

/** Applies an e2e clock change from storage.onChanged; true when it was one. */
export function applyClockChange(changes: Record<string, chrome.storage.StorageChange>): boolean {
  if (!__E2E__ || !(E2E_CLOCK_KEY in changes)) return false;
  const value: unknown = changes[E2E_CLOCK_KEY]?.newValue;
  offset = typeof value === 'number' ? value : 0;
  return true;
}
