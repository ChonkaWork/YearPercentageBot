import { clampSpeed, DEFAULT_SPEED } from './speed';

/**
 * Remembered speeds. Each value lives under its own storage key, so two tabs saving at the
 * same moment can't overwrite each other's entries (no read-modify-write).
 *
 *   speed:global         last speed used anywhere (number)
 *   speed:site:<host>    last speed used on a site ({ speed, at })
 */

export const GLOBAL_SPEED_KEY = 'speed:global';
export const SITE_SPEED_PREFIX = 'speed:site:';
/** Oldest per-site entries beyond this are dropped. */
export const MAX_SITE_SPEEDS = 300;

export interface SiteSpeed {
  speed: number;
  /** Last time it was saved (ms since epoch). */
  at: number;
}

export function siteSpeedKey(host: string): string {
  return `${SITE_SPEED_PREFIX}${host}`;
}

export function isSpeedKey(key: string): boolean {
  return key === GLOBAL_SPEED_KEY || key.startsWith(SITE_SPEED_PREFIX);
}

export function parseGlobalSpeed(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? clampSpeed(raw) : null;
}

export function parseSiteSpeed(raw: unknown): SiteSpeed | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { speed, at } = raw as Record<string, unknown>;
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return null;
  return { speed: clampSpeed(speed), at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
}

export interface RememberedSpeeds {
  global: number | null;
  site: SiteSpeed | null;
}

/**
 * Speed a newly found video starts at. A per-site default (Pro, passed only when the plan
 * includes it) wins. Otherwise, global mode: the last speed used anywhere; per-site mode: the
 * site's own last speed, or 1× for sites without one.
 */
export function resolveStartSpeed(
  remembered: RememberedSpeeds,
  rememberPerSite: boolean,
  host: string,
  siteDefault: number | null = null,
): number {
  if (siteDefault !== null && host) return clampSpeed(siteDefault);
  if (rememberPerSite && host) return remembered.site?.speed ?? DEFAULT_SPEED;
  return remembered.global ?? DEFAULT_SPEED;
}

/** Storage keys to delete so at most `max` valid per-site entries remain (oldest go first). */
export function siteKeysToPrune(items: Record<string, unknown>, max: number = MAX_SITE_SPEEDS): string[] {
  const valid: [string, number][] = [];
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(items)) {
    if (!key.startsWith(SITE_SPEED_PREFIX)) continue;
    const entry = parseSiteSpeed(value);
    if (entry && key.length > SITE_SPEED_PREFIX.length) valid.push([key, entry.at]);
    else invalid.push(key);
  }
  if (valid.length <= max) return invalid;
  valid.sort((a, b) => a[1] - b[1]);
  return [...invalid, ...valid.slice(0, valid.length - max).map(([key]) => key)];
}
