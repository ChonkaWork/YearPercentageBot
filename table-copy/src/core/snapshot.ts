/**
 * A plain-data snapshot of page content. It is produced inside the page by
 * src/page/reader.ts (which has the live DOM and computed styles), crosses the
 * extension boundary as JSON, and is turned into text, Markdown, HTML or table formats
 * by the pure converters in this folder.
 *
 * Only whitelisted tags and attributes ever make it into a snapshot, and every value in
 * it is data: converters escape text for their output format and never evaluate markup.
 */

export interface SnapText {
  t: 'text';
  v: string;
}

export interface SnapAttrs {
  /** <a>: absolute URL with a safe scheme, tracking parameters removed. */
  href?: string;
  /** <img>: absolute URL. */
  src?: string;
  /** <img>: alternative text. */
  alt?: string;
  /** <pre>/<code>: code language, from classes like `language-js`. */
  lang?: string;
  /** <td>/<th>. rowspan 0 means "to the end of the row group", as in HTML. */
  colspan?: number;
  rowspan?: number;
  /** <tr> or ARIA row: aria-rowindex (1-based position in the whole grid, for virtualized grids). */
  rowindex?: number;
  /** <ol>. */
  start?: number;
  reversed?: boolean;
  /** <li value>. */
  value?: number;
  /** <input type=checkbox> (the only kind of input kept, for task lists). */
  checked?: boolean;
}

export interface SnapElement {
  t: 'el';
  /** Lowercase tag name. */
  tag: string;
  a?: SnapAttrs;
  c: SnapNode[];
  /** The page lays the element out as a block (from its computed display). */
  block?: boolean;
  /** The page preserves line breaks in it (computed white-space: pre, pre-wrap, ...). */
  pre?: boolean;
}

export type SnapNode = SnapText | SnapElement;

export type SelectionSnapshot =
  | { kind: 'dom'; nodes: SnapNode[]; truncated: boolean; url: string }
  /** Selection inside a text field: plain text only. */
  | { kind: 'plain'; text: string; truncated: boolean; url: string }
  | { kind: 'empty'; url: string };

// --- Builders (used by tests and by the fallback path) ----------------------------------

export function text(v: string): SnapText {
  return { t: 'text', v };
}

export function el(tag: string, attrs?: SnapAttrs | null, ...children: (SnapNode | string)[]): SnapElement {
  const element: SnapElement = { t: 'el', tag, c: children.map((child) => (typeof child === 'string' ? text(child) : child)) };
  if (attrs && Object.keys(attrs).length > 0) element.a = attrs;
  return element;
}

export function isElement(node: SnapNode | null | undefined): node is SnapElement {
  return node?.t === 'el';
}

export function isText(node: SnapNode | null | undefined): node is SnapText {
  return node?.t === 'text';
}

// --- Semantics ---------------------------------------------------------------------------

/** Always blocks, whatever the page's CSS says: their meaning is structural. */
const STRUCTURAL_BLOCKS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'blockquote', 'hr',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
]);

/** Blocks by default, unless the page explicitly lays them out inline. */
const GENERIC_BLOCKS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'address', 'figure', 'figcaption',
  'details', 'summary', 'center', 'hgroup', 'search', 'form', 'fieldset', 'legend', 'menu', 'dir', 'body',
]);

export const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export function headingLevel(tag: string): number {
  return HEADING_TAGS.has(tag) ? Number(tag[1]) : 0;
}

export function isStructuralBlockTag(tag: string): boolean {
  return STRUCTURAL_BLOCKS.has(tag);
}

export function isGenericBlockTag(tag: string): boolean {
  return GENERIC_BLOCKS.has(tag);
}

export function isBlockLike(node: SnapNode): boolean {
  if (!isElement(node)) return false;
  if (node.tag === 'br') return false;
  if (STRUCTURAL_BLOCKS.has(node.tag)) return true;
  if (GENERIC_BLOCKS.has(node.tag)) return node.block !== false;
  return node.block === true;
}

/** True when the element has block-level descendants (e.g. a card link wrapping a heading). */
export function containsBlock(node: SnapElement): boolean {
  return node.c.some((child) => isElement(child) && (isBlockLike(child) || containsBlock(child)));
}

/** Raw text of a subtree, with <br> as a line break. */
export function textContent(node: SnapNode): string {
  if (!isElement(node)) return node.v;
  if (node.tag === 'br') return '\n';
  let out = '';
  for (const child of node.c) out += textContent(child);
  return out;
}
