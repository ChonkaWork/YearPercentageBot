import { normalizeTree } from './normalize';
import { containsBlock, isBlockLike, isElement, textContent, type SnapElement, type SnapNode } from './snapshot';
import { cleanImageUrl, cleanLinkUrl, escapeAttribute, escapeHtml, sanitizeLanguage } from './text';

/**
 * "Clean HTML": the structure of the selection (headings, paragraphs, lists, tables,
 * links, emphasis, code) without the site's styling, so pasting into Google Docs, Word
 * or an email keeps the structure but not the fonts, colors and layout.
 *
 * Sanitized by construction: the output is built from the snapshot with a fixed tag
 * whitelist and only these attributes: href (http/https/mailto/tel/ftp), src (http/https
 * or raster data: images), alt, colspan, rowspan, start, reversed, value and a
 * `language-*` class on code. No scripts, styles, classes, ids, event handlers or frames.
 */

const RENAME: Record<string, string> = {
  b: 'strong',
  i: 'em',
  cite: 'em',
  dfn: 'em',
  var: 'em',
  strike: 's',
  samp: 'code',
  tt: 'code',
};

const KEEP = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'figcaption',
  'strong', 'em', 'u', 's', 'del', 'ins', 'code', 'kbd', 'sub', 'sup', 'mark', 'small', 'abbr', 'q',
]);

/** Kept even when empty: they carry structure. */
const KEEP_EMPTY = new Set(['td', 'th', 'tr']);

/** A line break after these keeps the markup readable; whitespace between blocks is ignored. */
const NEWLINE_AFTER = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'figure', 'div', 'pre', 'hr',
]);

export function toCleanHtml(nodes: readonly SnapNode[]): string {
  return render(normalizeTree(nodes)).trim();
}

function render(nodes: readonly SnapNode[]): string {
  let out = '';
  for (const node of nodes) out += isElement(node) ? renderElement(node) : escapeHtml(node.v);
  return out;
}

function renderElement(node: SnapElement): string {
  const tag = RENAME[node.tag] ?? node.tag;
  switch (tag) {
    case 'br':
      return '<br>';
    case 'hr':
      return '<hr>\n';
    case 'pre': {
      const code = textContent(node).replace(/^\n/, '').replace(/\n+$/, '');
      const lang = sanitizeLanguage(node.a?.lang ?? findLanguage(node));
      return `<pre><code${lang ? ` class="language-${escapeAttribute(lang)}"` : ''}>${escapeHtml(code)}</code></pre>\n`;
    }
    case 'img': {
      const src = cleanImageUrl(node.a?.src);
      const alt = node.a?.alt ?? '';
      if (!src) return escapeHtml(alt);
      return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}">`;
    }
    case 'a': {
      const content = render(node.c);
      const href = cleanLinkUrl(node.a?.href);
      if (!href || !content.trim()) return content;
      return `<a href="${escapeAttribute(href)}">${content}</a>`;
    }
    case 'input':
      return node.a?.checked ? '☑ ' : '☐ ';
    default:
      break;
  }

  if (KEEP.has(tag)) {
    const content = render(node.c);
    if (!content.trim() && !KEEP_EMPTY.has(tag)) return '';
    return `<${tag}${attributes(tag, node)}>${content}</${tag}>${NEWLINE_AFTER.has(tag) ? '\n' : ''}`;
  }

  // Generic containers (div, section, span, custom elements...): no tag of their own.
  const content = render(node.c);
  if (!content.trim()) return '';
  if (isBlockLike(node)) {
    // Only needed as a line/paragraph boundary when it holds inline content directly.
    const onlyBlocks = node.c.every((child) => isElement(child) && (isBlockLike(child) || containsBlock(child)));
    return onlyBlocks ? content : `<div>${content}</div>\n`;
  }
  return content;
}

function attributes(tag: string, node: SnapElement): string {
  const a = node.a;
  if (!a) return '';
  let out = '';
  if ((tag === 'td' || tag === 'th') && a.colspan !== undefined && a.colspan !== 1) out += ` colspan="${int(a.colspan, 1, 1000)}"`;
  if ((tag === 'td' || tag === 'th') && a.rowspan !== undefined && a.rowspan !== 1) out += ` rowspan="${int(a.rowspan, 0, 65534)}"`;
  if (tag === 'ol' && a.start !== undefined && a.start !== 1) out += ` start="${int(a.start, -1e9, 1e9)}"`;
  if (tag === 'ol' && a.reversed) out += ' reversed';
  if (tag === 'li' && a.value !== undefined) out += ` value="${int(a.value, -1e9, 1e9)}"`;
  if (tag === 'code') {
    const lang = sanitizeLanguage(a.lang);
    if (lang) out += ` class="language-${escapeAttribute(lang)}"`;
  }
  return out;
}

function int(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
}

function findLanguage(node: SnapElement): string | undefined {
  for (const child of node.c) {
    if (!isElement(child)) continue;
    if (child.a?.lang) return child.a.lang;
    const nested = findLanguage(child);
    if (nested) return nested;
  }
  return undefined;
}
