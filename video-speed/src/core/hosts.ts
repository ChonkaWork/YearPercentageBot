/**
 * Hostnames for the blocklist and per-site memory. Pure functions (URL is available in every
 * context, including Node for tests).
 */

export const MAX_BLOCKLIST = 500;

/**
 * Turns user input into a comparable hostname: "https://www.Example.com:8080/watch?v=1" →
 * "example.com". Unicode names become punycode (what `location.hostname` reports). A leading
 * "www." or "*." is dropped because entries match subdomains anyway. Returns null when the
 * input isn't a hostname.
 */
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  if (!value || value.length > 253 + 16) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  } else {
    value = value.split(/[/?#]/, 1)[0] ?? '';
  }
  value = value.replace(/^\*\./, '').replace(/^\.+/, '');
  if (!value || /[\s@\\]/.test(value)) return null;
  let host: string;
  try {
    host = new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.+$/, '');
  if (host.startsWith('www.') && host.length > 4) host = host.slice(4);
  if (!host || host.length > 253) return null;
  // IPv6 literals keep their brackets; everything else must be dotted labels.
  if (!host.startsWith('[') && !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(host)) {
    return null;
  }
  return host;
}

/** "example.com" matches example.com and all of its subdomains. */
export function hostMatches(entry: string, host: string): boolean {
  if (!entry || !host) return false;
  const bare = host.toLowerCase().replace(/\.+$/, '');
  return bare === entry || bare.endsWith(`.${entry}`);
}

/** The blocklist entry that matches `host`, if any. */
export function blockingEntry(blocklist: readonly string[], host: string): string | null {
  for (const entry of blocklist) if (hostMatches(entry, host)) return entry;
  return null;
}

export function sanitizeBlocklist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw) {
    const host = normalizeHost(item);
    if (host && !result.includes(host)) result.push(host);
    if (result.length >= MAX_BLOCKLIST) break;
  }
  return result;
}

/** Entries to remove so that `host` is no longer blocked. */
export function entriesBlocking(blocklist: readonly string[], host: string): string[] {
  return blocklist.filter((entry) => hostMatches(entry, host));
}

/**
 * The site a frame belongs to: the top-level page's hostname. Embedded players (iframes)
 * learn it from `location.ancestorOrigins`, whose last entry is the top frame's origin.
 */
export function siteHostOf(frameHostname: string, ancestorOrigins: readonly string[]): string {
  const top = ancestorOrigins[ancestorOrigins.length - 1];
  if (top) {
    try {
      const hostname = new URL(top).hostname;
      if (hostname) return hostname.toLowerCase();
    } catch {
      // Opaque origins ("null") fall through to the frame's own hostname.
    }
  }
  return frameHostname.toLowerCase();
}

/** Short form for UI: drops "www.". */
export function displayHost(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}
