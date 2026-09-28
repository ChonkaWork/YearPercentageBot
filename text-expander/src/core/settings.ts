/** Settings model and the per-site disable list. Pure functions. */

import { isSortOrder, type SortOrder } from './usage';

export const TRIGGER_MODES = ['immediate', 'delimiter'] as const;
export type TriggerMode = (typeof TRIGGER_MODES)[number];

export interface Settings {
  /** `immediate`: expand as soon as the abbreviation is typed. `delimiter`: after Space, Tab or Enter. */
  triggerMode: TriggerMode;
  /** Hostnames where nothing expands. An entry also covers its subdomains. */
  disabledSites: string[];
  /** Show matching snippets under the caret while an abbreviation is being typed. */
  autocomplete: boolean;
  /** How the manager lists snippets. */
  managerSort: SortOrder;
}

export const MAX_DISABLED_SITES = 500;

export function defaultSettings(): Settings {
  return { triggerMode: 'immediate', disabledSites: [], autocomplete: true, managerSort: 'az' };
}

export function isTriggerMode(value: unknown): value is TriggerMode {
  return typeof value === 'string' && (TRIGGER_MODES as readonly string[]).includes(value);
}

/** Accepts anything read from storage and returns valid settings, falling back per field. */
export function sanitizeSettings(raw: unknown): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const sites: string[] = [];
  if (Array.isArray(input.disabledSites)) {
    for (const entry of input.disabledSites) {
      const host = typeof entry === 'string' ? normalizeHostname(entry) : null;
      if (host && !sites.includes(host)) sites.push(host);
      if (sites.length >= MAX_DISABLED_SITES) break;
    }
  }
  const defaults = defaultSettings();
  return {
    triggerMode: isTriggerMode(input.triggerMode) ? input.triggerMode : defaults.triggerMode,
    disabledSites: sites,
    autocomplete: typeof input.autocomplete === 'boolean' ? input.autocomplete : defaults.autocomplete,
    managerSort: isSortOrder(input.managerSort) ? input.managerSort : defaults.managerSort,
  };
}

/**
 * Turns what a user types or pastes ("https://Mail.Example.com/inbox", "*.example.com",
 * "example.com:8080") into a bare hostname. Returns null when it isn't one.
 */
export function normalizeHostname(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^\*\./, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = `http://${value}`;
  let host: string;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    host = url.hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  // IPv6 literals keep their brackets; everything else must be a plain DNS name or IPv4.
  if (!host.startsWith('[') && !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return null;
  return host;
}

/** True when `hostname` is `entry` or a subdomain of it. */
export function hostMatches(hostname: string, entry: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === entry || host.endsWith(`.${entry}`);
}

/**
 * The entry that disables any of `hostnames` (a frame's own host and the hosts of the pages
 * it is embedded in), or null.
 */
export function findDisablingEntry(hostnames: readonly string[], disabledSites: readonly string[]): string | null {
  for (const entry of disabledSites) {
    if (hostnames.some((host) => host && hostMatches(host, entry))) return entry;
  }
  return null;
}

export function addDisabledSite(sites: readonly string[], hostname: string): string[] {
  const host = normalizeHostname(hostname);
  if (!host || sites.includes(host)) return [...sites];
  return [...sites, host];
}

/** Re-enables `hostname`: removes every entry that covers it (including parent domains). */
export function removeDisabledSitesFor(sites: readonly string[], hostname: string): string[] {
  return sites.filter((entry) => !hostMatches(hostname, entry));
}
