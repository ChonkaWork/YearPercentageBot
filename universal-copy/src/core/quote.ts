import type { ClipboardPayload } from './convert';
import { destination, escapeText } from './markdown';
import { pageLinkTitle } from './pageLink';
import { quoteBaseUrl, withTextFragment } from './textFragment';
import { escapeAttribute, escapeHtml, removeInvisible } from './text';

/**
 * "Copy as quote with link": the selection as a quote, followed by a link to the page that
 * opens it scrolled to (and highlighting) exactly that passage. Pure.
 *
 *   Markdown   > The quoted text
 *              >
 *              > Second paragraph
 *
 *              — [Page title](https://example.com/post#:~:text=The%20quoted%20text)
 *
 *   Plain      “The quoted text” — Page title, https://example.com/post#:~:text=...
 *
 * text/html always carries the rich version (a <blockquote> and a link) so Google Docs,
 * Word and email clients paste a formatted quote; text/plain carries the chosen style.
 */

export type QuoteStyle = 'markdown' | 'text';
export const QUOTE_STYLES: readonly QuoteStyle[] = ['markdown', 'text'];

export interface QuoteContent {
  /** The selection as Markdown. */
  markdown: string;
  /** The selection as clean text. */
  text: string;
  /** The selection as clean HTML, when it has structure worth keeping. */
  html?: string;
}

export interface QuoteSource {
  title: string;
  url: string;
  /** The text directive (`text=...`) that finds the passage, if one could be built. */
  fragment: string | null;
}

export interface Quote {
  payload: ClipboardPayload;
  /** The link in the quote (with the text fragment), or null for pages without a web address. */
  link: string | null;
}

export function buildQuote(content: QuoteContent, source: QuoteSource, style: QuoteStyle): Quote {
  const base = quoteBaseUrl(source.url);
  const link = base ? withTextFragment(base, source.fragment) : null;
  const title = base ? pageLinkTitle(source.title, base) : removeInvisible(source.title).replace(/\s+/g, ' ').trim();
  const text = style === 'markdown' ? markdownQuote(content.markdown, title, link) : plainQuote(content.text, title, link);
  return { payload: { text, html: htmlQuote(content, title, link) }, link };
}

function markdownQuote(markdown: string, title: string, link: string | null): string {
  const body = markdown
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  const label = escapeText(title || 'Source');
  const credit = link ? `— [${label}](${destination(link)})` : title ? `— ${label}` : '';
  return credit ? `${body}\n\n${credit}` : body;
}

function plainQuote(text: string, title: string, link: string | null): string {
  const body = `“${text.trim()}”`;
  const credit = [title, link].filter(Boolean).join(', ');
  if (!credit) return body;
  return body.includes('\n') ? `${body}\n— ${credit}` : `${body} — ${credit}`;
}

function htmlQuote(content: QuoteContent, title: string, link: string | null): string {
  const inner =
    content.html?.trim() ||
    content.text
      .trim()
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
      .join('\n');
  const cite = link ? ` cite="${escapeAttribute(link)}"` : '';
  const label = escapeHtml(title || link || '');
  const credit = link ? `<p>— <a href="${escapeAttribute(link)}">${label}</a></p>` : label ? `<p>— ${label}</p>` : '';
  return `<blockquote${cite}>\n${inner}\n</blockquote>\n${credit}`.trim();
}
