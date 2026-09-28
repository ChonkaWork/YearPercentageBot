import { decimalSeparatorFor, type DecimalSeparator } from '../core/cellValue';
import { tableDataFromSnapshot } from '../core/extract';
import { toPlainText } from '../core/plainText';
import { isGenericBlockTag, type SnapAttrs, type SnapElement, type SnapNode } from '../core/snapshot';
import { layoutGrid, type TableData } from '../core/table';
import { cleanImageUrl, cleanLinkUrl, isFootnoteMarker } from '../core/text';

/**
 * Runs inside the page (injected on demand). Reads a table from the live DOM into a
 * snapshot: only what is actually visible (computed styles), only whitelisted tags and
 * attributes. Never modifies the page.
 */

export interface ReadLimits {
  maxChars: number;
  maxElements: number;
}

export const DEFAULT_LIMITS: ReadLimits = { maxChars: 2_000_000, maxElements: 200_000 };

/** Never part of a cell's text: code, embeds, media, form controls, metadata. */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'canvas',
  'svg', 'math', 'audio', 'video', 'source', 'track', 'map', 'area', 'button', 'select', 'option', 'optgroup',
  'datalist', 'textarea', 'input', 'dialog', 'head', 'meta', 'link', 'title', 'base', 'slot', 'portal', 'progress',
  'meter', 'param',
]);

interface State {
  view: Window;
  base: string;
  limits: ReadLimits;
  chars: number;
  elements: number;
  truncated: boolean;
  rowLimit: { table: Element; max: number; count: number } | null;
}

function createState(doc: Document, limits: ReadLimits): State {
  return { view: doc.defaultView ?? window, base: doc.baseURI, limits, chars: 0, elements: 0, truncated: false, rowLimit: null };
}

// --- Tree walk ----------------------------------------------------------------------------

function snapChildren(parent: Node, state: State): SnapNode[] {
  const out: SnapNode[] = [];
  for (const child of Array.from(parent.childNodes)) {
    if (state.truncated) break;
    const node = snapNode(child, state);
    if (node) out.push(node);
  }
  return out;
}

function snapNode(node: Node, state: State): SnapNode | null {
  if (state.truncated) return null;
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    let value = (node as CharacterData).data;
    const room = state.limits.maxChars - state.chars;
    if (value.length > room) {
      value = value.slice(0, Math.max(0, room));
      state.truncated = true;
    }
    state.chars += value.length;
    return value ? { t: 'text', v: value } : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  return snapElement(node as Element, state, false);
}

function snapElement(element: Element, state: State, force: boolean): SnapElement | null {
  const tag = element.tagName.toLowerCase();
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null;
  if (SKIP_TAGS.has(tag)) return null;
  if (++state.elements > state.limits.maxElements) {
    state.truncated = true;
    return null;
  }
  const style = state.view.getComputedStyle(element);
  if (!force && (isHidden(element, style) || isJunk(element, tag))) return null;

  if (tag === 'tr' && state.rowLimit && element.closest('table') === state.rowLimit.table) {
    if (state.rowLimit.count >= state.rowLimit.max) return null;
    state.rowLimit.count++;
  }

  const snap: SnapElement = { t: 'el', tag, c: snapChildren(element, state) };
  const attrs = attributesOf(element, tag, state);
  if (attrs) snap.a = attrs;
  applyLayout(snap, tag, style);
  return snap;
}

function applyLayout(snap: SnapElement, tag: string, style: CSSStyleDeclaration): void {
  const display = style.display;
  const block = display ? !(display.startsWith('inline') || display === 'contents' || display.startsWith('ruby')) : undefined;
  if (block === true) snap.block = true;
  else if (block === false && isGenericBlockTag(tag)) snap.block = false;
  if (preservesBreaks(style)) snap.pre = true;
}

function preservesBreaks(style: CSSStyleDeclaration): boolean {
  const whiteSpace = style.whiteSpace;
  if (whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'pre-line' || whiteSpace === 'break-spaces') return true;
  const collapse = style.getPropertyValue('white-space-collapse');
  return collapse === 'preserve' || collapse === 'preserve-breaks' || collapse === 'break-spaces';
}

function isHidden(element: Element, style: CSSStyleDeclaration): boolean {
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  if (style.getPropertyValue('content-visibility') === 'hidden') return true;
  if (isVisuallyHidden(style)) return true;
  return element.getAttribute('aria-hidden') === 'true';
}

/** "Screen reader only" text: clipped to nothing or 1px, off-screen. */
function isVisuallyHidden(style: CSSStyleDeclaration): boolean {
  if (style.position !== 'absolute' && style.position !== 'fixed') return false;
  if (/^rect\(\s*[01]px,?\s+[01]px,?\s+[01]px,?\s+[01]px\s*\)$/.test(style.clip)) return true;
  if (style.clipPath === 'inset(50%)' || style.clipPath === 'inset(100%)') return true;
  const width = Number.parseFloat(style.width);
  const height = Number.parseFloat(style.height);
  return width <= 1 && height <= 1 && (style.overflow === 'hidden' || style.overflow === 'clip');
}

/** Site furniture that is visible but junk in data: Wikipedia edit links, footnote markers, sort keys. */
function isJunk(element: Element, tag: string): boolean {
  if (element.classList.contains('mw-editsection') || element.classList.contains('sortkey')) return true;
  if (tag === 'sup' && (element.classList.contains('reference') || isFootnoteMarker(element.textContent ?? ''))) return true;
  return false;
}

function attributesOf(element: Element, tag: string, state: State): SnapAttrs | undefined {
  const attrs: SnapAttrs = {};
  switch (tag) {
    case 'a': {
      const href = cleanLinkUrl(element.getAttribute('href'), state.base);
      if (href) attrs.href = href;
      break;
    }
    case 'img': {
      // Cells with only an icon (a check mark) fall back to its alt text.
      const src = cleanImageUrl(element.getAttribute('src'), state.base);
      if (src) attrs.src = src;
      const alt = element.getAttribute('alt');
      if (alt) attrs.alt = alt;
      break;
    }
    case 'td':
    case 'th': {
      const cell = element as HTMLTableCellElement;
      if (cell.colSpan !== 1) attrs.colspan = cell.colSpan;
      if (cell.rowSpan !== 1) attrs.rowspan = cell.rowSpan;
      break;
    }
    default:
      break;
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

// --- Tables -------------------------------------------------------------------------------

export interface TableSnapshot {
  table: SnapElement;
  truncated: boolean;
}

/** The whole table (hidden rows, cells and sort keys excluded). */
export function snapshotTable(table: Element, limits: ReadLimits = DEFAULT_LIMITS, maxRows?: number): TableSnapshot {
  const state = createState(table.ownerDocument, limits);
  if (maxRows !== undefined) state.rowLimit = { table, max: maxRows, count: 0 };
  const snap = snapElement(table, state, true) ?? { t: 'el', tag: 'table', c: [] };
  return { table: snap, truncated: state.truncated };
}

/**
 * The table the user means: the innermost table holding the whole selection, otherwise
 * the first (outermost) table the selection overlaps.
 */
export function findSelectedTable(doc: Document = document): Element | { none: 'no-selection' | 'no-table' } {
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return { none: 'no-selection' };
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const start = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
  const inside = start?.closest('table');
  if (inside) return inside;
  const touched = Array.from(doc.querySelectorAll('table')).filter((table) => range.intersectsNode(table) && isListable(table));
  const outer = touched.filter((table) => !touched.some((other) => other !== table && other.contains(table)));
  return outer[0] ?? { none: 'no-table' };
}

/** How many top-level tables the selection overlaps (to say "the first of 3 tables"). */
export function overlappingTables(doc: Document = document): number {
  const selection = doc.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (!range) return 1;
  const count = Array.from(doc.querySelectorAll('table')).filter(
    (table) => range.intersectsNode(table) && !table.parentElement?.closest('table') && isListable(table),
  ).length;
  return Math.max(1, count);
}

export interface TableSummary {
  /** Position in document.querySelectorAll('table'), to read the table again later. */
  index: number;
  title: string;
  rows: number;
  columns: number;
  headerRows: number;
  /** First rows (header rows first), at most PREVIEW_COLUMNS columns, values shortened. */
  preview: string[][];
  signature: string;
}

export interface TableList {
  tables: TableSummary[];
  /** Tables found, including those beyond `maxTables`. */
  total: number;
}

export const PREVIEW_ROWS = 4;
export const PREVIEW_COLUMNS = 6;
const PREVIEW_CHARS = 48;

export function listTables(doc: Document = document, maxTables = 100): TableList {
  const all = Array.from(doc.querySelectorAll('table'));
  const tables: TableSummary[] = [];
  let total = 0;
  all.forEach((table, index) => {
    if (!isListable(table)) return;
    const size = measureTable(table as HTMLTableElement);
    if (size.cells < 2 || size.rows === 0) return;
    total++;
    if (tables.length >= maxTables) return;
    tables.push({ index, title: tableTitle(table), rows: size.rows, columns: size.columns, ...preview(table), signature: tableSignature(table) });
  });
  return { tables, total };
}

export interface PageInfo {
  pageTitle: string;
  url: string;
  /** Decimal separator of the page's language, for .xlsx numbers. */
  decimal: DecimalSeparator;
}

export type TableRead =
  | { status: 'ok'; data: TableData; title: string; overlapping: number; page: PageInfo }
  | { status: 'no-selection' | 'no-table' | 'changed' };

export function pageInfo(doc: Document = document): PageInfo {
  const lang = doc.documentElement.lang || doc.querySelector('meta[http-equiv="content-language" i]')?.getAttribute('content') || '';
  return { pageTitle: doc.title.trim(), url: doc.location?.href ?? '', decimal: decimalSeparatorFor(lang || undefined) };
}

/** A whole table as a grid of cell texts, with its title and where it came from. */
export function readTable(table: Element, overlapping = 1): TableRead {
  const { table: snap, truncated } = snapshotTable(table);
  const data = tableDataFromSnapshot(snap);
  return {
    status: 'ok',
    data: { ...data, truncated: data.truncated || truncated },
    title: tableTitle(table),
    overlapping,
    page: pageInfo(table.ownerDocument),
  };
}

export function findTableAt(doc: Document, index: number, signature: string): Element | null {
  const table = doc.querySelectorAll('table')[index];
  return table && tableSignature(table) === signature ? table : null;
}

function isListable(table: Element): boolean {
  const role = table.getAttribute('role');
  if (role === 'presentation' || role === 'none') return false;
  return isRendered(table);
}

function isRendered(element: Element): boolean {
  const withCheck = element as Element & { checkVisibility?: (options?: Record<string, boolean>) => boolean };
  if (typeof withCheck.checkVisibility === 'function') {
    return withCheck.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  }
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === 'none') return false;
    if (node === element && (style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
  }
  return true;
}

/** Row and column counts from the table structure (fast: no text, no snapshot). */
function measureTable(table: HTMLTableElement): { rows: number; columns: number; cells: number } {
  const view = table.ownerDocument.defaultView;
  const visible = (row: HTMLTableRowElement) => !view || view.getComputedStyle(row).display !== 'none';
  const groups: HTMLTableRowElement[][] = [];
  const head: HTMLTableRowElement[] = [];
  const foot: HTMLTableRowElement[] = [];
  let implicit: HTMLTableRowElement[] | null = null;
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase();
    const rowsOf = () => Array.from((child as HTMLTableSectionElement).rows).filter(visible);
    if (tag === 'thead') head.push(...rowsOf());
    else if (tag === 'tfoot') foot.push(...rowsOf());
    else if (tag === 'tbody') groups.push(rowsOf());
    else if (tag === 'tr' && visible(child as HTMLTableRowElement)) {
      if (!implicit) groups.push((implicit = []));
      implicit.push(child as HTMLTableRowElement);
      continue;
    } else continue;
    implicit = null;
  }
  const ordered = [head, ...groups, foot].filter((group) => group.length > 0);
  const layout = layoutGrid(
    ordered.map((group) => group.map((row) => Array.from(row.cells))),
    (cell) => ({ colSpan: cell.colSpan, rowSpan: cell.rowSpan }),
  );
  let cells = 0;
  for (const group of ordered) for (const row of group) cells += row.cells.length;
  const rows = ordered.flat().filter((row) => (row.textContent ?? '').trim() !== '').length;
  return { rows, columns: layout.width, cells };
}

function preview(table: Element): { preview: string[][]; headerRows: number } {
  const { table: snap } = snapshotTable(table, DEFAULT_LIMITS, PREVIEW_ROWS + 3);
  const data = tableDataFromSnapshot(snap);
  const rows = data.rows.slice(0, Math.max(PREVIEW_ROWS, data.headerRows + 2)).map((row) =>
    row.slice(0, PREVIEW_COLUMNS).map((value) => shorten(value.replace(/\s*\n\s*/g, ' '), PREVIEW_CHARS)),
  );
  return { preview: rows, headerRows: Math.min(data.headerRows, rows.length) };
}

/** Caption, ARIA label, or the nearest heading before the table. */
export function tableTitle(table: Element): string {
  const doc = table.ownerDocument;
  const caption = (table as HTMLTableElement).caption;
  const fromCaption = caption ? elementText(caption) : '';
  if (fromCaption) return shorten(fromCaption, 80);
  const label = table.getAttribute('aria-label');
  if (label?.trim()) return shorten(squash(label), 80);
  const labelledBy = table.getAttribute('aria-labelledby');
  const labelElement = labelledBy ? doc.getElementById(labelledBy.split(/\s+/)[0] ?? '') : null;
  if (labelElement) return shorten(elementText(labelElement), 80);

  let steps = 0;
  for (let current: Element | null = table; current && current !== doc.body && steps < 60; current = current.parentElement) {
    for (let previous = current.previousElementSibling; previous && steps < 60; previous = previous.previousElementSibling, steps++) {
      if (/^h[1-6]$/i.test(previous.tagName)) return shorten(elementText(previous), 80);
      const headings = previous.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const last = headings[headings.length - 1];
      if (last) return shorten(elementText(last), 80);
      if (previous.tagName.toLowerCase() === 'table' || previous.querySelector('table')) return '';
    }
  }
  return '';
}

function elementText(element: Element): string {
  const state = createState(element.ownerDocument, DEFAULT_LIMITS);
  const snap = snapElement(element, state, true);
  return snap ? squash(toPlainText(snap.c)) : '';
}

function tableSignature(table: Element): string {
  const rows = (table as HTMLTableElement).rows;
  return `${rows.length}|${squash(rows[0]?.textContent ?? '').slice(0, 80)}`;
}

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}
