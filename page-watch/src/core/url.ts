/** Only http(s) pages can be watched. Returns the URL without its #fragment, or null. */
export function normalizeWatchUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  return url.href;
}

export function isWatchableUrl(value: unknown): boolean {
  return normalizeWatchUrl(value) !== null;
}

/** "https://shop.example.com" */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/** Match pattern for chrome.permissions covering exactly this origin: "https://shop.example.com/*". */
export function originPattern(url: string): string {
  return `${new URL(url).origin}/*`;
}

/** "shop.example.com" without "www.". */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** "shop.example.com/product/42" for compact display. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.hostname.replace(/^www\./, '')}${path}${parsed.search}`;
  } catch {
    return url;
  }
}
