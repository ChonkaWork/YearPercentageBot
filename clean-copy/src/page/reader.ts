import { isGenericBlockTag, type SelectionSnapshot, type SnapAttrs, type SnapElement, type SnapNode } from '../core/snapshot';
import { cleanImageUrl, cleanLinkUrl, isFootnoteMarker, languageFromClass, sanitizeLanguage } from '../core/text';

/**
 * Copied from Universal Copy (extensions stay self-contained), selection reading only.
 *
 * Runs inside the page (injected on demand, or in the auto-clean content script). Reads the
 * selection from the live DOM into a snapshot: only what is actually visible (computed styles), only whitelisted
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
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null;
  const checkbox = tag === 'input' && (element as HTMLInputElement).type === 'checkbox';
  if (SKIP_TAGS.has(tag) && !checkbox) return null;
  if (++state.elements > state.limits.maxElements) {
    state.truncated = true;
    return null;
  }
  const style = state.view.getComputedStyle(element);
  if (!force && (isHidden(element, style, state) || isJunk(element, tag))) return null;

  const snap: SnapElement = { t: 'el', tag, c: checkbox ? [] : snapChildren(element, state) };
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

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
