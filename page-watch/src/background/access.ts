import type { Watch } from '../core/types';
import { originOf, originPattern } from '../core/url';

export { patternMatcher, watchesForPatterns } from '../core/permissions';

/**
 * Host access is optional and per site: it's requested (by the popup, during a click) when a
 * watch is added, and given back when the last watch for that site is deleted.
 */

export async function hasAccess(url: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    return false;
  }
}

/** Removes access to a site once no watch uses it. Required (test build) permissions can't be removed; that's fine. */
export async function releaseAccessIfUnused(url: string, watches: readonly Watch[]): Promise<void> {
  let origin: string;
  try {
    origin = originOf(url);
  } catch {
    return;
  }
  if (watches.some((watch) => originOf(watch.url) === origin)) return;
  try {
    await chrome.permissions.remove({ origins: [originPattern(url)] });
  } catch {
    // Not granted as an optional permission.
  }
}
