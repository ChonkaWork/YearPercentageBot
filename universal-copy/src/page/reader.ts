import { hintWords } from '../core/article';
import { normalizeTree } from '../core/normalize';
import { plainCellText, toPlainText } from '../core/plainText';
import { isGenericBlockTag, isElement, type SelectionSnapshot, type SnapAttrs, type SnapElement, type SnapNode } from '../core/snapshot';
import { buildTableModel, extractTableData, layoutGrid } from '../core/table';
import { cleanImageUrl, cleanLinkUrl, isFootnoteMarker, languageFromClass, sanitizeLanguage } from '../core/text';
import { outermostMath, readMath } from './math';

/**
 * Runs inside the page (injected on demand). Reads the selection or a table from the live
 * DOM into a snapshot: only what is actually visible (computed styles), only whitelisted
 * tags and attributes, URLs resolved to absolute ones. Never modifies the page.
 */

export interface ReadLimits {
  maxChars: number;
  maxElements: number;
}

export const DEFAULT_LIMITS: ReadLimits = { maxChars: 2_000_000, maxElements: 200_000 };

/** Never part of copied content: code, embeds, media, form controls, metadata. */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'canvas',
  'svg', 'math', 'audio', 'video', 'source', 'track', 'map', 'area', 'button', 'select', 'option', 'optgroup',
  'datalist', 'textarea', 'input', 'dialog', 'head', 'meta', 'link', 'title', 'base', 'slot', 'portal', 'progress',
  'meter', 'object', 'param',
]);

/** Inline formatting that gives a partial selection its meaning (a word inside a link stays a link). */
const INLINE_CONTEXT = new Set([
  'a', 'strong', 'b', 'em', 'i', 's', 'del', 'strike', 'code', 'kbd', 'samp', 'tt', 'sub', 'sup', 'mark', 'u', 'ins', 'q', 'cite',
]);

const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

interface State {
  view: Window;
  base: string;
  range: Range | null;
  /** Selections skip user-select:none content (line numbers, UI chrome), like Chrome's own copy. */
  respectUserSelect: boolean;
  limits: ReadLimits;
  chars: number;
  elements: number;
  truncated: boolean;
  rowLimit: { table: Element; max: number; count: number } | null;
  /** Whole-page snapshots: record id/class/role hints for the article extractor. */
  hints: boolean;
}

function createState(doc: Document, limits: ReadLimits, range: Range | null, respectUserSelect: boolean): State {
  return {
    view: doc.defaultView ?? window,
    base: doc.baseURI,
    range,
    respectUserSelect,
    limits,
    chars: 0,
    elements: 0,
    truncated: false,
    rowLimit: null,
    hints: false,
  };
}

// --- Selection ----------------------------------------------------------------------------

export function snapshotSelection(doc: Document = document, limits: ReadLimits = DEFAULT_LIMITS): SelectionSnapshot {
  const url = doc.location?.href ?? '';
  const field = readTextField(doc, limits.maxChars);
  if (field) return { kind: 'plain', text: field.text, truncated: field.truncated, url };

  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return { kind: 'empty', url };

  const state = createState(doc, limits, null, true);
  const nodes: SnapNode[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (range.collapsed) continue;
    state.range = range;
    nodes.push(...snapshotRange(range, state));
  }
  return { kind: 'dom', nodes, truncated: state.truncated, url };
}

/**
 * The whole page, for "Copy article": everything visible in <body> (user-select is ignored:
 * some sites block selecting their articles), with id/class/role hints on every element.
 */
export function snapshotDocument(doc: Document = document, limits: ReadLimits = DEFAULT_LIMITS): { nodes: SnapNode[]; truncated: boolean } {
  const state = createState(doc, limits, null, false);
  state.hints = true;
  const body = doc.body ?? doc.documentElement;
  return { nodes: snapChildren(body, state), truncated: state.truncated };
}

/** Selections inside <textarea>/<input> are not part of the document selection. */
function readTextField(doc: Document, maxChars: number): { text: string; truncated: boolean } | null {
  const active = doc.activeElement;
  const view = doc.defaultView;
  if (!view || !(active instanceof view.HTMLTextAreaElement || active instanceof view.HTMLInputElement)) return null;
  try {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start === null || end === null || end <= start) return null;
    // Never read password fields.
    if (active instanceof view.HTMLInputElement && active.type === 'password') return null;
    const text = active.value.slice(start, end);
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  } catch {
    return null;
  }
}

function snapshotRange(range: Range, state: State): SnapNode[] {
  const common = range.commonAncestorContainer;
  // A selection inside a formula copies the whole formula.
  const formula = outermostMath(common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement);
  if (formula) {
    const node = snapElement(formula, state, true);
    let content: SnapNode[] = node ? [node] : [];
    const wrappers = contextWrappers(range, formula, state);
    for (let i = wrappers.length - 1; i >= 0; i--) {
      const wrapper = wrappers[i];
      if (wrapper) content = [{ ...wrapper, c: content }];
    }
    return content;
  }
  let content: SnapNode[];
  if (common.nodeType === Node.TEXT_NODE || common.nodeType === Node.CDATA_SECTION_NODE) {
    const node = snapNode(common, state);
    content = node ? [node] : [];
  } else {
    content = snapChildren(common, state);
  }

  const start = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
  // Line breaks the page preserves (white-space: pre-wrap) must survive a partial selection.
  if (start && !start.closest('pre') && preservesBreaks(state.view.getComputedStyle(start))) {
    content = [{ t: 'el', tag: 'span', c: content, pre: true }];
  }

  const wrappers = contextWrappers(range, common, state);
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const wrapper = wrappers[i];
    if (wrapper) content = [{ ...wrapper, c: content }];
  }
  return content;
}

/**
 * Ancestors of the selection that carry meaning for it: inline formatting and <pre>
 * always, the list/table around several selected items/rows, and headings, list items
 * and quotes when the selection covers them entirely.
 */
function contextWrappers(range: Range, common: Node, state: State): SnapElement[] {
  const doc = common.ownerDocument ?? (common as Document);
  const commonIsElement = common.nodeType === Node.ELEMENT_NODE;
  const start = commonIsElement ? (common as Element) : common.parentElement;
  const chain: SnapElement[] = [];
  let needTable = false;
  let needList = false;

  for (let node: Element | null = start; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    const isCommon = commonIsElement && node === common;
    let include = false;
    if (INLINE_CONTEXT.has(tag) || tag === 'pre') {
      include = true;
    } else if (TABLE_PARTS.has(tag)) {
      if (isCommon) needTable = true;
      include = needTable;
      if (tag === 'table') needTable = false;
    } else if (tag === 'td' || tag === 'th') {
      include = needTable;
    } else if (tag === 'ul' || tag === 'ol') {
      include = isCommon || needList;
      needList = false;
    } else if (tag === 'li') {
      include = isFullyCovered(range, node);
      needList = include;
    } else if (HEADINGS.has(tag) || tag === 'blockquote') {
      include = (isCommon && tag === 'blockquote') || isFullyCovered(range, node);
    }
    if (include) {
      const shallow = shallowElement(node, tag, state);
      if (shallow) chain.push(shallow);
    }
  }
  return chain.reverse();
}

function isFullyCovered(range: Range, node: Element): boolean {
  const doc = node.ownerDocument;
  const contents = doc.createRange();
  contents.selectNodeContents(node);
  const startsBefore = range.compareBoundaryPoints(range.START_TO_START, contents) <= 0;
  const endsAfter = range.compareBoundaryPoints(range.END_TO_END, contents) >= 0;
  if (startsBefore && endsAfter) return true;
  // Tolerate whitespace at the edges (triple-click, drag past the end of a line).
  const clipped = contents.cloneRange();
  if (!startsBefore) clipped.setStart(range.startContainer, range.startOffset);
  if (!endsAfter) clipped.setEnd(range.endContainer, range.endOffset);
  return squash(clipped.toString()) === squash(node.textContent ?? '') && squash(node.textContent ?? '') !== '';
}

function shallowElement(element: Element, tag: string, state: State): SnapElement | null {
  const style = state.view.getComputedStyle(element);
  const snap: SnapElement = { t: 'el', tag, c: [] };
  const attrs = attributesOf(element, tag, state);
  if (attrs) snap.a = attrs;
  applyLayout(snap, tag, style);
  return snap;
}

// --- Tree walk ----------------------------------------------------------------------------

function snapChildren(parent: Node, state: State): SnapNode[] {
  const out: SnapNode[] = [];
  for (const child of Array.from(parent.childNodes)) {
    if (state.truncated) break;
    if (state.range && !state.range.intersectsNode(child)) continue;
    const node = snapNode(child, state);
    if (node) out.push(node);
  }
  return out;
}

function snapNode(node: Node, state: State): SnapNode | null {
  if (state.truncated) return null;
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    let value = (node as CharacterData).data;
    const range = state.range;
    if (range) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : value.length;
      value = value.slice(start, end);
    }
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
  const math = readMath(element);
  if (math !== null) return mathElement(element, tag, math, state, force);
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null;
  const checkbox = tag === 'input' && (element as HTMLInputElement).type === 'checkbox';
  if (SKIP_TAGS.has(tag) && !checkbox) return null;
  if (++state.elements > state.limits.maxElements) {
    state.truncated = true;
    return null;
  }
  const style = state.view.getComputedStyle(element);
  if (!force && (isHidden(element, style, state) || isJunk(element, tag))) return null;

  if (tag === 'tr' && state.rowLimit && element.closest('table') === state.rowLimit.table) {
    if (state.rowLimit.count >= state.rowLimit.max) return null;
    state.rowLimit.count++;
  }

  const snap: SnapElement = { t: 'el', tag, c: checkbox ? [] : snapChildren(element, state) };
  const attrs = attributesOf(element, tag, state);
  if (attrs) snap.a = attrs;
  applyLayout(snap, tag, style);
  if (state.hints) {
    const fixed = style.position === 'fixed' || style.position === 'sticky';
    const hints = hintWords(element.getAttribute('id'), element.getAttribute('class'), element.getAttribute('role'), fixed);
    if (hints) snap.k = hints;
  }
  return snap;
}

/** A formula as one node with its LaTeX (see ./math.ts). */
function mathElement(element: Element, tag: string, math: Exclude<ReturnType<typeof readMath>, null>, state: State, force: boolean): SnapElement | null {
  if (math === 'skip') return null;
  if (++state.elements > state.limits.maxElements) {
    state.truncated = true;
    return null;
  }
  // MathJax 2 keeps its source in a hidden <script>; everything else must be visible.
  if (tag !== 'script' && !force) {
    let style: CSSStyleDeclaration | null = null;
    try {
      style = state.view.getComputedStyle(element);
    } catch {
      // Some engines can't style MathML elements: treat them as visible.
    }
    if (style && isHidden(element, style, state)) return null;
  }
  state.chars += math.tex.length;
  const snap: SnapElement = { t: 'el', tag: 'math', a: { tex: math.tex }, c: [] };
  if (math.display && snap.a) {
    snap.a.display = true;
    snap.block = true;
  }
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

function isHidden(element: Element, style: CSSStyleDeclaration, state: State): boolean {
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  if (style.getPropertyValue('content-visibility') === 'hidden') return true;
  if (isVisuallyHidden(style)) return true;
  // aria-hidden and user-select:none on a container the selection starts or ends in are
  // ignored: some sites hide the whole app from screen readers while a dialog is open.
  const holdsSelection = () =>
    state.range !== null && (element.contains(state.range.startContainer) || element.contains(state.range.endContainer));
  if (element.getAttribute('aria-hidden') === 'true' && !holdsSelection()) return true;
  if (state.respectUserSelect && (style.userSelect === 'none' || style.getPropertyValue('-webkit-user-select') === 'none')) {
    return !holdsSelection();
  }
  return false;
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

/** Site furniture that is visible but junk in a copy: Wikipedia edit links, footnote markers. */
function isJunk(element: Element, tag: string): boolean {
  if (element.classList.contains('mw-editsection')) return true;
  if (tag === 'sup' && (element.classList.contains('reference') || isFootnoteMarker(element.textContent ?? ''))) return true;
  return false;
}

// --- Attributes ---------------------------------------------------------------------------

function attributesOf(element: Element, tag: string, state: State): SnapAttrs | undefined {
  const attrs: SnapAttrs = {};
  switch (tag) {
    case 'a': {
      const href = cleanLinkUrl(element.getAttribute('href'), state.base);
      if (href) attrs.href = href;
      break;
    }
    case 'img': {
      const src = imageSource(element as HTMLImageElement, state.base);
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
    case 'ol': {
      const list = element as HTMLOListElement;
      if (list.hasAttribute('start') && Number.isFinite(list.start)) attrs.start = list.start;
      if (list.reversed) attrs.reversed = true;
      break;
    }
    case 'li': {
      const value = Number.parseInt(element.getAttribute('value') ?? '', 10);
      if (Number.isFinite(value)) attrs.value = value;
      break;
    }
    case 'input':
      attrs.checked = (element as HTMLInputElement).checked;
      break;
    case 'pre':
    case 'code': {
      const lang = codeLanguage(element, tag);
      if (lang) attrs.lang = lang;
      break;
    }
    default:
      break;
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

/** Lazy-loading placeholders are skipped in favor of the real image. */
function imageSource(image: HTMLImageElement, base: string): string | null {
  const current = image.currentSrc || image.getAttribute('src') || '';
  const lazy = image.getAttribute('data-src') || image.getAttribute('data-lazy-src') || image.getAttribute('data-original') || '';
  const pick = lazy && (!current || current.startsWith('data:')) ? lazy : current;
  return cleanImageUrl(pick, base);
}

function codeLanguage(element: Element, tag: string): string | null {
  const direct =
    sanitizeLanguage(element.getAttribute('data-lang')) ??
    sanitizeLanguage(element.getAttribute('data-language')) ??
    languageFromClass(element.getAttribute('class'));
  if (direct) return direct;
  if (tag === 'pre') {
    const code = element.querySelector(':scope > code');
    const fromCode = code ? languageFromClass(code.getAttribute('class')) ?? sanitizeLanguage(code.getAttribute('data-lang')) : null;
    if (fromCode) return fromCode;
    // GitHub wraps code in <div class="highlight highlight-source-js">.
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth++, ancestor = ancestor.parentElement) {
      const lang = languageFromClass(ancestor.getAttribute('class')) ?? sanitizeLanguage(ancestor.getAttribute('data-lang'));
      if (lang) return lang;
    }
  }
  return null;
}

// --- Tables -------------------------------------------------------------------------------

export interface TableSnapshot {
  table: SnapElement;
  truncated: boolean;
}

/** The whole table (hidden rows, cells and sort keys excluded; user-select is irrelevant here). */
export function snapshotTable(table: Element, limits: ReadLimits = DEFAULT_LIMITS, maxRows?: number): TableSnapshot {
  const state = createState(table.ownerDocument, limits, null, false);
  if (maxRows !== undefined) state.rowLimit = { table, max: maxRows, count: 0 };
  const snap = snapElement(table, state, true) ?? { t: 'el', tag: 'table', c: [] };
  return { table: snap, truncated: state.truncated };
}

export type SelectedTable =
  | { status: 'ok'; table: SnapElement; truncated: boolean; overlapping: number; title: string }
  | { status: 'no-selection' }
  | { status: 'no-table' };

/**
 * The table the user means: the innermost table holding the whole selection, otherwise
 * the first (outermost) table the selection overlaps.
 */
export function findSelectedTable(doc: Document = document): Element | { none: 'no-selection' | 'no-table'; overlapping?: number } {
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

export function readSelectedTable(doc: Document = document, limits: ReadLimits = DEFAULT_LIMITS): SelectedTable {
  const found = findSelectedTable(doc);
  if ('none' in found) return { status: found.none };
  const selection = doc.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const overlapping = range
    ? Array.from(doc.querySelectorAll('table')).filter(
        (table) => range.intersectsNode(table) && !table.parentElement?.closest('table') && isListable(table),
      ).length
    : 1;
  const { table, truncated } = snapshotTable(found, limits);
  return { status: 'ok', table, truncated, overlapping: Math.max(1, overlapping), title: tableTitle(found) };
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

const PREVIEW_ROWS = 3;
const PREVIEW_COLUMNS = 6;
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
    tables.push({ index, title: tableTitle(table), ...size, ...preview(table), signature: tableSignature(table) });
  });
  return { tables, total };
}

export type TableRead =
  | { status: 'ok'; table: SnapElement; truncated: boolean; title: string }
  | { status: 'changed' };

export function readTableAt(doc: Document, index: number, signature: string, limits: ReadLimits = DEFAULT_LIMITS): TableRead {
  const table = doc.querySelectorAll('table')[index];
  if (!table || tableSignature(table) !== signature) return { status: 'changed' };
  const { table: snap, truncated } = snapshotTable(table, limits);
  return { status: 'ok', table: snap, truncated, title: tableTitle(table) };
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
  const [normalized] = normalizeTree([snap]);
  if (!isElement(normalized)) return { preview: [], headerRows: 0 };
  const data = extractTableData(buildTableModel(normalized), (cell) => plainCellText(cell), 'repeat');
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
  const state = createState(element.ownerDocument, DEFAULT_LIMITS, null, false);
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
