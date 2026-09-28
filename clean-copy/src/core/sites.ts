/**
 * Sites with auto-clean (Pro). A site is an exact host name ("docs.example.com"); its
 * permission is the narrowest match pattern that covers it, `*://docs.example.com/*`
 * (http and https, any port, any path). Pure: no Chrome APIs.
 */

export type SiteInput = { ok: true; host: string } | { ok: false; message: string };

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Accepts "example.com", "https://example.com/some/page", "EXAMPLE.com:8080"... */
export function parseSiteInput(value: string): SiteInput {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: 'Enter a site, for example news.example.com.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: "That doesn't look like a web address." };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'Only regular web pages (http and https) can be auto-cleaned.' };
  }
  const host = hostOf(url.href);
  if (!host) return { ok: false, message: "That doesn't look like a web address." };
  return { ok: true, host };
}

/** The host of an http(s) URL, lowercase, or null for anything else (chrome://, file://...). */
export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return HOST.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function originPattern(host: string): string {
  return `*://${host}/*`;
}

/** The host of a pattern made by originPattern, or null for anything else. */
export function hostFromPattern(pattern: string): string | null {
  const match = /^(?:\*|https?):\/\/([^/*]+)\/\*$/.exec(pattern);
  return match?.[1] && HOST.test(match[1]) ? match[1] : null;
}

/** Stored list: valid, lowercase, unique hosts, in the order they were added. */
export function sanitizeSites(raw: unknown, max = 100): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const host = item.trim().toLowerCase();
    if (!HOST.test(host) || out.includes(host)) continue;
    out.push(host);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Which sites are really active: in the list and covered by a granted permission. A site can
 * be in the list without permission (the prompt was dismissed, or the permission was removed
 * on chrome://extensions); it is then shown as "needs permission".
 */
export function activeSites(sites: readonly string[], grantedOrigins: readonly string[]): string[] {
  const all = grantedOrigins.includes('<all_urls>') || grantedOrigins.includes('*://*/*');
  const granted = new Set(grantedOrigins.map(hostFromPattern).filter((host): host is string => host !== null));
  return sites.filter((host) => all || granted.has(host));
}
