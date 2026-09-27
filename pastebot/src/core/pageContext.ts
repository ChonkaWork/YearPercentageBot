import type { PageContext } from './types';

const MAX_TITLE_CHARS = 200;
const MAX_URL_CHARS = 2_000;

/** Marketing / click-tracking parameters that add nothing to a prompt. */
const TRACKING_PARAM = /^(?:utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|mc_cid|mc_eid|igshid|si|_hsenc|_hsmi|mkt_tok|ref_src|ref_url|trk|trkinfo|tracking_?id)$/i;

/** Parameters that may carry credentials or one-time secrets. Never put them in a prompt. */
const SENSITIVE_PARAM = /(?:token|secret|password|passwd|api[_-]?key|apikey|^auth(?:orization)?$|session|signature|^sig$|^code$|^state$|^otp$|^key$|^sid$)/i;

/** Fragments like "#access_token=..." (OAuth implicit flow) are dropped entirely. */
const SENSITIVE_FRAGMENT = /(?:access_token|id_token|refresh_token|token|code|state)=/i;

/**
 * Normalizes page metadata before it goes into a prompt:
 * - only http(s) URLs (no file://, chrome://, extension URLs that leak local paths or IDs)
 * - no embedded credentials, tracking or secret-looking query parameters
 * - titles are single-line and bounded
 */
export function sanitizePageContext(context: PageContext | null | undefined): PageContext | null {
  if (!context) return null;
  const title = sanitizeTitle(context.title);
  const url = sanitizeUrl(context.url);
  if (!title && !url) return null;
  const result: PageContext = {};
  if (title) result.title = title;
  if (url) result.url = url;
  return result;
}

export function sanitizeTitle(title: string | undefined): string | undefined {
  if (typeof title !== 'string') return undefined;
  const clean = title.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > MAX_TITLE_CHARS ? `${clean.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : clean;
}

export function sanitizeUrl(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  url.username = '';
  url.password = '';
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(name) || SENSITIVE_PARAM.test(name)) url.searchParams.delete(name);
  }
  if (SENSITIVE_FRAGMENT.test(url.hash)) url.hash = '';

  let result = url.toString();
  if (result.length > MAX_URL_CHARS) {
    url.search = '';
    url.hash = '';
    result = url.toString();
  }
  return result.length > MAX_URL_CHARS ? undefined : result;
}
