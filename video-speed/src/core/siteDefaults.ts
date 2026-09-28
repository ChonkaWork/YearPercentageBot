import { hostMatches, normalizeHost } from './hosts';
import { MAX_PRESETS, MAX_SITE_DEFAULTS } from './plan';
import { clampSpeed, PRESET_SPEEDS, sameSpeed } from './speed';

/**
 * Pro: per-site default speeds and custom popup presets. Pure functions.
 *
 * A rule "example.com → 1.5×" makes every video found on example.com (and its subdomains,
 * embedded players included) start at 1.5×, instead of the remembered speed.
 */

export interface SiteDefault {
  host: string;
  speed: number;
}

/** Valid, de-duplicated rules (first entry per host wins), at most MAX_SITE_DEFAULTS. */
export function sanitizeSiteDefaults(raw: unknown): SiteDefault[] {
  if (!Array.isArray(raw)) return [];
  const result: SiteDefault[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (result.length >= MAX_SITE_DEFAULTS) break;
    if (typeof item !== 'object' || item === null) continue;
    const { host: rawHost, speed } = item as Record<string, unknown>;
    const host = normalizeHost(rawHost);
    if (!host || seen.has(host) || typeof speed !== 'number' || !Number.isFinite(speed)) continue;
    seen.add(host);
    result.push({ host, speed: clampSpeed(speed) });
  }
  return result;
}

/** The rule for a site: the most specific matching entry (video.example.com beats example.com). */
export function siteDefaultFor(rules: readonly SiteDefault[], host: string): SiteDefault | null {
  let best: SiteDefault | null = null;
  for (const rule of rules) {
    if (hostMatches(rule.host, host) && (!best || rule.host.length > best.host.length)) best = rule;
  }
  return best;
}

/** Adds or replaces the rule for `host` (normalized). Returns the list unchanged for an invalid host. */
export function upsertSiteDefault(rules: readonly SiteDefault[], host: string, speed: number): SiteDefault[] {
  const normalized = normalizeHost(host);
  if (!normalized) return [...rules];
  const rule = { host: normalized, speed: clampSpeed(speed) };
  const index = rules.findIndex((entry) => entry.host === normalized);
  if (index === -1) return [...rules, rule];
  return rules.map((entry, i) => (i === index ? rule : entry));
}

export function removeSiteDefault(rules: readonly SiteDefault[], host: string): SiteDefault[] {
  return rules.filter((entry) => entry.host !== host);
}

/** Sorted by host for display. */
export function sortedSiteDefaults(rules: readonly SiteDefault[]): SiteDefault[] {
  return [...rules].sort((a, b) => a.host.localeCompare(b.host));
}

// --- Presets -------------------------------------------------------------------------------

/** Valid presets: clamped, unique, ascending, 1 to MAX_PRESETS. Anything else → the defaults. */
export function sanitizePresets(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...PRESET_SPEEDS];
  const result: number[] = [];
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isFinite(item)) continue;
    const speed = clampSpeed(item);
    if (!result.some((existing) => sameSpeed(existing, speed))) result.push(speed);
  }
  if (!result.length) return [...PRESET_SPEEDS];
  return result.sort((a, b) => a - b).slice(0, MAX_PRESETS);
}

export type PresetEdit = { ok: true; presets: number[] } | { ok: false; error: string };

/** Adds a preset. Refuses duplicates and a full list with a message for the user. */
export function addPreset(presets: readonly number[], speed: number, max: number = MAX_PRESETS): PresetEdit {
  if (!Number.isFinite(speed)) return { ok: false, error: 'Enter a speed, like 1.5.' };
  const value = clampSpeed(speed);
  if (presets.some((existing) => sameSpeed(existing, value))) return { ok: false, error: `${value}× is already a preset.` };
  if (presets.length >= max) return { ok: false, error: `The popup has room for ${max} presets. Remove one first.` };
  return { ok: true, presets: [...presets, value].sort((a, b) => a - b) };
}

/** Removes a preset; the last one stays (the popup always shows at least one). */
export function removePreset(presets: readonly number[], speed: number): PresetEdit {
  if (presets.length <= 1) return { ok: false, error: 'Keep at least one preset.' };
  return { ok: true, presets: presets.filter((existing) => !sameSpeed(existing, speed)) };
}

/** The presets the popup shows: the user's own with custom presets, the built-in ones otherwise. */
export function activePresets(custom: readonly number[], customAllowed: boolean): number[] {
  return customAllowed ? [...custom] : [...PRESET_SPEEDS];
}
