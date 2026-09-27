import type { Watch } from './types';

/** Watches affected when access to these match patterns was removed. */
export function watchesForPatterns(watches: readonly Watch[], patterns: readonly string[]): Watch[] {
  const matchers = patterns.map(patternMatcher);
  return watches.filter((watch) => matchers.some((matches) => matches(watch.url)));
}

/** Tiny matcher for the host patterns this extension uses ("https://*\/*", "https://a.com/*", "*://*.a.com/*"). */
export function patternMatcher(pattern: string): (url: string) => boolean {
  if (pattern === '<all_urls>') return (url) => /^https?:/.test(url);
  const match = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
  if (!match) return () => false;
  const [, scheme, host] = match as unknown as [string, string, string];
  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const protocol = parsed.protocol.slice(0, -1);
    if (scheme !== '*' && scheme !== protocol) return false;
    const [hostPattern, port] = host.split(/:(?=[^\]]*$)/) as [string, string | undefined];
    if (port !== undefined && port !== '*' && port !== (parsed.port || (protocol === 'https' ? '443' : '80'))) return false;
    if (hostPattern === '*') return true;
    if (hostPattern.startsWith('*.')) {
      const base = hostPattern.slice(2);
      return parsed.hostname === base || parsed.hostname.endsWith(`.${base}`);
    }
    return parsed.hostname === hostPattern;
  };
}
