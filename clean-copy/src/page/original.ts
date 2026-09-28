import type { Original } from '../core/lastCopy';
import { LAST_COPY_LIMITS } from '../core/lastCopy';
import { escapeAttribute, escapeHtml } from '../core/text';

/**
 * What a normal copy of the current selection would have put on the clipboard, kept so the
 * clean copy can be undone: the selection's text (as Chrome gives it) and its HTML.
 *
 * The HTML is written as a string, never built as elements, so nothing in the page runs,
 * loads or changes. Only formatting-relevant tags and attributes are kept, links and images
 * get absolute addresses, scripts, forms and hidden elements are skipped. For selections of
 * up to STYLED_ELEMENTS elements, the visible styles (color, font, weight...) are written
 * inline the way Chrome does on copy, so the original pastes the way it looked.
 */

const STYLED_ELEMENTS = 1500;

/** Never part of copied HTML. */
const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'canvas', 'svg',
  'math', 'audio', 'video', 'source', 'track', 'map', 'area', 'button', 'select', 'option', 'optgroup', 'datalist', 'textarea',
  'dialog', 'head', 'meta', 'link', 'title', 'base', 'slot', 'portal', 'param',
]);
const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr', 'col']);
/** Ancestors of a partial selection that give it its meaning. */
const CONTEXT = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'code', 'kbd', 'sub', 'sup', 'small', 'q', 'cite', 'pre',
  'ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
const STYLE_PROPS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration-line'] as const;

interface Writer {
  view: Window;
  range: Range;
  styled: boolean;
  out: string;
  tooBig: boolean;
  styles: Map<Element, CSSStyleDeclaration>;
}

/** The selection's text and HTML, or the selected part of a text field (text only). */
export function readOriginal(doc: Document, field: string | null = null): Original | null {
  if (field !== null) return field.length <= LAST_COPY_LIMITS.maxOriginalText ? { text: field } : null;
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const text = selection.toString();
  if (text.length > LAST_COPY_LIMITS.maxOriginalText) return null;
  const original: Original = { text };
  try {
    const html = selectionHtml(selection, doc);
    if (html) original.html = html;
  } catch {
    // Text only: Undo still restores the words.
  }
  return original;
}

export function selectionHtml(selection: Selection, doc: Document): string | null {
  const view = doc.defaultView;
  if (!view) return null;
  let html = '';
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (range.collapsed) continue;
    const writer: Writer = { view, range, styled: countElements(range) <= STYLED_ELEMENTS, out: '', tooBig: false, styles: new Map() };
    writeRange(writer);
    if (writer.tooBig) return null;
    html += writer.out;
    if (html.length > LAST_COPY_LIMITS.maxOriginalHtml) return null;
  }
  return html || null;
}

function countElements(range: Range): number {
  const root = range.commonAncestorContainer;
  if (root.nodeType !== Node.ELEMENT_NODE) return 0;
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let count = 0;
  for (let node = walker.nextNode(); node && count <= STYLED_ELEMENTS; node = walker.nextNode()) {
    if (range.intersectsNode(node)) count++;
  }
  return count;
}

function writeRange(writer: Writer): void {
  const { range } = writer;
  const common = range.commonAncestorContainer;
  if (common.nodeType === Node.TEXT_NODE || common.nodeType === Node.CDATA_SECTION_NODE) {
    writeText(writer, common as CharacterData);
  } else {
    for (const child of Array.from(common.childNodes)) writeNode(writer, child);
  }
  // Wrap in the ancestors that carry meaning: a word inside a link stays a link.
  const start = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
  let inner = writer.out;
  for (let element = start; element && element.tagName !== 'BODY' && element.tagName !== 'HTML'; element = element.parentElement) {
    const tag = element.tagName.toLowerCase();
    if (!CONTEXT.has(tag)) continue;
    inner = `${openTag(writer, element, tag, true)}${inner}</${tag}>`;
  }
  writer.out = inner;
}

function writeNode(writer: Writer, node: Node): void {
  if (writer.tooBig || !writer.range.intersectsNode(node)) return;
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    writeText(writer, node as CharacterData);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
  const tag = element.tagName.toLowerCase();
  const checkbox = tag === 'input' && (element as HTMLInputElement).type === 'checkbox';
  if ((SKIP.has(tag) || tag === 'input') && !checkbox) return;
  if (writer.styled && styleOf(writer, element).display === 'none') return;
  append(writer, openTag(writer, element, tag, false));
  if (VOID.has(tag)) return;
  for (const child of Array.from(element.childNodes)) writeNode(writer, child);
  append(writer, `</${tag}>`);
}

function writeText(writer: Writer, node: CharacterData): void {
  let value = node.data;
  const { range } = writer;
  const end = node === range.endContainer ? range.endOffset : value.length;
  const start = node === range.startContainer ? range.startOffset : 0;
  value = value.slice(start, end);
  if (value) append(writer, escapeHtml(value));
}

function append(writer: Writer, value: string): void {
  writer.out += value;
  if (writer.out.length > LAST_COPY_LIMITS.maxOriginalHtml) writer.tooBig = true;
}

function openTag(writer: Writer, element: Element, tag: string, context: boolean): string {
  const attrs: string[] = [];
  const add = (name: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value !== '') attrs.push(`${name}="${escapeAttribute(value)}"`);
  };
  switch (tag) {
    case 'a': {
      const href = (element as HTMLAnchorElement).href;
      if (/^(?:https?|mailto|tel):/i.test(href)) add('href', href);
      break;
    }
    case 'img': {
      const image = element as HTMLImageElement;
      const src = image.currentSrc || image.src;
      if (/^https?:/i.test(src) || /^data:image\/(?:png|gif|jpe?g|webp|avif);/i.test(src)) add('src', src);
      add('alt', image.getAttribute('alt'));
      break;
    }
    case 'td':
    case 'th': {
      const cell = element as HTMLTableCellElement;
      if (cell.colSpan > 1) add('colspan', String(cell.colSpan));
      if (cell.rowSpan > 1) add('rowspan', String(cell.rowSpan));
      break;
    }
    case 'ol':
      if (element.hasAttribute('start')) add('start', String((element as HTMLOListElement).start));
      break;
    case 'input':
      attrs.push('type="checkbox"', 'disabled=""');
      if ((element as HTMLInputElement).checked) attrs.push('checked=""');
      break;
    default:
      break;
  }
  if (writer.styled && !context) add('style', inlineStyle(writer, element));
  return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
}

/** The visible styles that differ from the parent's, like Chrome writes them on copy. */
function inlineStyle(writer: Writer, element: Element): string {
  const style = styleOf(writer, element);
  const parent = element.parentElement ? styleOf(writer, element.parentElement) : null;
  const top = !parent || !writer.range.intersectsNode(element.parentElement as Element) || element.parentElement === writer.range.commonAncestorContainer;
  const parts: string[] = [];
  for (const prop of STYLE_PROPS) {
    const value = style.getPropertyValue(prop);
    if (!value || (prop === 'background-color' && /^(?:transparent|rgba\(0, 0, 0, 0\))$/.test(value))) continue;
    if (prop === 'text-decoration-line' && value === 'none') continue;
    if (!top && parent?.getPropertyValue(prop) === value) continue;
    parts.push(`${prop}: ${value}`);
  }
  return parts.join('; ');
}

function styleOf(writer: Writer, element: Element): CSSStyleDeclaration {
  let style = writer.styles.get(element);
  if (!style) {
    style = writer.view.getComputedStyle(element);
    writer.styles.set(element, style);
  }
  return style;
}
