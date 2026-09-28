/**
 * Small text helpers shared by every converter. Content is never rewritten: only
 * characters that are invisible junk in copied text are removed.
 */

/**
 * Zero-width space, word joiner, BOM, soft hyphen, Mongolian vowel separator and the
 * invisible math operators. ZWJ/ZWNJ and bidi marks are kept on purpose: emoji
 * sequences and several scripts need them.
 */
const INVISIBLE = /[​⁠﻿­᠎⁡-⁤]/g;

/** No-break space, figure space, narrow no-break space. */
const SPECIAL_SPACES = /[   ]/g;

export function removeInvisible(value: string): string {
  return value.replace(INVISIBLE, '').replace(SPECIAL_SPACES, ' ');
}

/**
 * Final tidy-up for plain text: LF line endings, no trailing spaces (tabs are kept, they
 * are empty table cells), at most one blank line in a row, no blank lines at the edges.
 */
export function tidyText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/ +$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Normalizes text that arrives as plain text (text fields, Chrome's selectionText). */
export function normalizePlainText(value: string): string {
  return tidyText(removeInvisible(value.replace(/\r\n?/g, '\n')).replace(/[ \t]+$/gm, ''));
}

// --- URLs --------------------------------------------------------------------------------

/** Marketing and click-tracking parameters that are junk in a copied link. */
const TRACKING_PARAM =
  /^(?:utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|mkt_tok|ref_src|oly_anon_id|oly_enc_id|vero_id|__s|s_cid|trk|trkinfo)$/i;

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:']);

/**
 * Resolves a link against the page, keeps only safe schemes (no javascript:, data:, ...)
 * and removes tracking parameters. Returns null for anything that isn't a usable link.
 */
export function cleanLinkUrl(raw: string | null | undefined, base?: string): string | null {
  const url = parseUrl(raw, base);
  if (!url || !SAFE_LINK_PROTOCOLS.has(url.protocol)) return null;
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    let changed = false;
    for (const name of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    // URLSearchParams re-encodes the query; only touch it when something was removed.
    if (changed) return url.toString().replace(/\?(?=#|$)/, '');
  }
  return url.toString();
}

const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,[a-z0-9+/=\s]+$/i;

/** Image sources: absolute http(s) URLs, or raster data: URLs (never SVG, which can hold scripts). */
export function cleanImageUrl(raw: string | null | undefined, base?: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  if (value.startsWith('data:')) return DATA_IMAGE.test(value) ? value : null;
  const url = parseUrl(value, base);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  return url.toString();
}

function parseUrl(raw: string | null | undefined, base?: string): URL | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return new URL(raw.trim(), base);
  } catch {
    return null;
  }
}

/** True when `href` points at the same document as `pageUrl` (ignoring the fragment). */
export function isSamePageLink(href: string, pageUrl: string | undefined): boolean {
  if (!pageUrl) return false;
  try {
    const a = new URL(href);
    const b = new URL(pageUrl);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

/** Short form of a URL for comparisons: no scheme, no `www.`, no trailing slash. */
export function bareUrl(href: string): string {
  return href
    .replace(/^mailto:/i, '')
    .replace(/^tel:/i, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '');
}

// --- Escaping ----------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

// --- Code languages ----------------------------------------------------------------------

const LANGUAGE_CLASS = [
  /(?:^|\s)(?:language|lang)-([\w+#.-]+)/i,
  /(?:^|\s)highlight-(?:source|text)-([\w+#.-]+)/i,
  /(?:^|\s)brush:\s*([\w+#.-]+)/i,
];

/** Code language from class names used by GitHub, highlight.js, Prism, Rouge, SyntaxHighlighter. */
export function languageFromClass(className: string | null | undefined): string | null {
  if (!className) return null;
  for (const pattern of LANGUAGE_CLASS) {
    const match = pattern.exec(className);
    if (match?.[1]) return sanitizeLanguage(match[1]);
  }
  return null;
}

export function sanitizeLanguage(value: string | null | undefined): string | null {
  if (!value) return null;
  const lang = value.trim().toLowerCase();
  if (!/^[\w+#.-]{1,30}$/.test(lang) || lang === 'none' || lang === 'plaintext' || lang === 'text' || lang === 'nohighlight') {
    return null;
  }
  return lang;
}

// --- Page junk ---------------------------------------------------------------------------

/** "[1]", "[a]", "[citation needed]", "[edit]": footnote and edit markers (Wikipedia and friends). */
export function isFootnoteMarker(value: string): boolean {
  return /^\[[^\[\]\n]{1,30}\]$/.test(value.replace(/\s+/g, ' ').trim());
}
