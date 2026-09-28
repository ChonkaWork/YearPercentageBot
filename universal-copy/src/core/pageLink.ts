import type { ClipboardPayload } from './convert';
import { destination, escapeText } from './markdown';
import { cleanLinkUrl, escapeAttribute, escapeHtml, removeInvisible } from './text';

/**
 * "Copy page link as Markdown": `[Page title](https://link)` with tracking parameters
 * removed, plus an HTML link for rich editors. Pure: the title and URL come from the tab.
 */

/** Only web pages have an address worth sharing (not chrome://, file:, data:...). */
export function cleanPageUrl(raw: string | null | undefined): string | null {
  const url = cleanLinkUrl(raw);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** The title on one line; the address (without scheme and `www.`) when the page has none. */
export function pageLinkTitle(title: string | null | undefined, url: string): string {
  const clean = removeInvisible(title ?? '').replace(/\s+/g, ' ').trim();
  if (clean) return clean;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

export function pageLinkMarkdown(title: string | null | undefined, rawUrl: string | null | undefined): ClipboardPayload | null {
  const url = cleanPageUrl(rawUrl);
  if (!url) return null;
  const label = pageLinkTitle(title, url);
  return {
    text: `[${escapeText(label)}](${destination(url)})`,
    html: `<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`,
  };
}
