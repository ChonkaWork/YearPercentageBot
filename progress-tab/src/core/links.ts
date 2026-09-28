import { normalizeName, truncate } from './countdown';

/**
 * Quick links: name + web address tiles under the clock. Only http and https addresses are
 * accepted, so a tile can never run script (`javascript:`) or open a local file. There are no
 * favicons (that would need a permission or a network request): each tile shows the first letter
 * of its name.
 */

export interface QuickLink {
  id: string;
  name: string;
  /** Normalized absolute http(s) URL. */
  url: string;
}

export type LinkFields = Pick<QuickLink, 'name' | 'url'>;

/** Hard cap for every plan (Pro's "unlimited"); the plan's own limit is checked on add. */
export const MAX_LINKS = 100;
export const MAX_LINK_NAME_LENGTH = 40;
export const MAX_URL_LENGTH = 2048;

export type UrlProblem = 'empty' | 'invalid' | 'scheme' | 'credentials' | 'long';

/** Added in front of a bare host ("github.com"). */
const DEFAULT_SCHEME = 'https:';

/**
 * Turns what the user typed into an absolute http(s) URL. A bare host gets `https://`
 * ("github.com", "localhost:3000"); any other scheme is refused.
 */
export function parseLinkUrl(text: string): { ok: true; url: string } | { ok: false; problem: UrlProblem } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, problem: 'empty' };
  if (/\s/.test(trimmed)) return { ok: false, problem: 'invalid' };
  // "scheme:" but not "host:port".
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `${DEFAULT_SCHEME}//${trimmed}`);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, problem: 'scheme' };
  // "https://" alone or "https://.": nothing to open. A dotless host is fine (intranet, localhost).
  if (!url.hostname || /^\.+$/.test(url.hostname)) return { ok: false, problem: 'invalid' };
  if (url.username || url.password) return { ok: false, problem: 'credentials' };
  if (url.href.length > MAX_URL_LENGTH) return { ok: false, problem: 'long' };
  return { ok: true, url: url.href };
}

const URL_MESSAGES: Record<UrlProblem, string> = {
  empty: 'Enter a web address.',
  invalid: 'Enter a web address, like example.com.',
  scheme: 'Only web addresses (http:// or https://) can be added.',
  credentials: 'Leave the user name and password out of the address.',
  long: `Use an address of at most ${MAX_URL_LENGTH} characters.`,
};

/** "news.example.com" for "https://www.news.example.com/today". */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The avatar letter: the first letter or digit of the name (uppercased), else its first character. */
export function linkLetter(link: Pick<QuickLink, 'name' | 'url'>): string {
  const label = link.name || hostLabel(link.url);
  const letter = /[\p{L}\p{N}]/u.exec(label)?.[0] ?? Array.from(label)[0] ?? '?';
  return letter.toLocaleUpperCase('en');
}

// --- Form validation ---------------------------------------------------------------------------

export interface LinkDraft {
  name: string;
  url: string;
}

export type LinkField = 'name' | 'url';
export type LinkErrors = Partial<Record<LinkField, string>>;
export type LinkResult = { ok: true; value: LinkFields } | { ok: false; errors: LinkErrors };

/** The name is optional: without one the tile is named after the site ("github.com"). */
export function validateLinkDraft(draft: LinkDraft): LinkResult {
  const errors: LinkErrors = {};
  const parsed = parseLinkUrl(draft.url);
  if (!parsed.ok) errors.url = URL_MESSAGES[parsed.problem];
  const typed = normalizeName(draft.name);
  if (typed.length > MAX_LINK_NAME_LENGTH) errors.name = `Use at most ${MAX_LINK_NAME_LENGTH} characters.`;
  if (!parsed.ok || errors.name) return { ok: false, errors };
  return { ok: true, value: { name: typed || truncate(hostLabel(parsed.url), MAX_LINK_NAME_LENGTH), url: parsed.url } };
}

// --- List operations (pure; storage applies them) ----------------------------------------------

export class LinkLimitError extends Error {
  constructor(message = `You can have up to ${MAX_LINKS} quick links. Delete one to add another.`) {
    super(message);
    this.name = 'LinkLimitError';
  }
}

export function createLink(fields: LinkFields, id: string): QuickLink {
  return { id, ...fields };
}

/**
 * Appends a link, or puts it back at `index` (undo after a delete). `max` only blocks adding;
 * undo passes none, like countdowns.
 */
export function addLink(list: readonly QuickLink[], link: QuickLink, max = MAX_LINKS, limitMessage?: string, index?: number): QuickLink[] {
  if (list.some((item) => item.id === link.id)) return [...list];
  if (list.length >= Math.min(max, MAX_LINKS)) throw new LinkLimitError(max < MAX_LINKS ? limitMessage : undefined);
  const next = [...list];
  next.splice(index === undefined ? next.length : Math.max(0, Math.min(index, next.length)), 0, link);
  return next;
}

export function updateLink(list: readonly QuickLink[], id: string, fields: LinkFields): QuickLink[] {
  return list.map((item) => (item.id === id ? { ...item, ...fields } : item));
}

export function removeLink(list: readonly QuickLink[], id: string): QuickLink[] {
  return list.filter((item) => item.id !== id);
}

/** Moves a link `delta` places (−1 = left, +1 = right), stopping at either end. */
export function moveLink(list: readonly QuickLink[], id: string, delta: number): QuickLink[] {
  const from = list.findIndex((item) => item.id === id);
  if (from < 0) return [...list];
  const to = Math.max(0, Math.min(list.length - 1, from + Math.trunc(delta)));
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** Accepts anything read from storage and keeps the valid links (at most MAX_LINKS). */
export function sanitizeLinks(raw: unknown): QuickLink[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: QuickLink[] = [];
  for (const item of raw) {
    if (result.length >= MAX_LINKS) break;
    if (typeof item !== 'object' || item === null) continue;
    const input = item as Record<string, unknown>;
    const id = typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 64 ? input.id : null;
    if (!id || seen.has(id) || typeof input.url !== 'string') continue;
    const parsed = parseLinkUrl(input.url);
    if (!parsed.ok) continue;
    const typed = typeof input.name === 'string' ? truncate(normalizeName(input.name), MAX_LINK_NAME_LENGTH) : '';
    seen.add(id);
    result.push({ id, name: typed || truncate(hostLabel(parsed.url), MAX_LINK_NAME_LENGTH), url: parsed.url });
  }
  return result;
}
