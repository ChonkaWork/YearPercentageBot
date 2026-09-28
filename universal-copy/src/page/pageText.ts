import type { PageTextModel } from '../core/textFragment';
import { MATH_SELECTOR } from './math';

/**
 * The page's visible text the way the browser's find-in-page (and so Text Fragment
 * matching) sees it, with the offsets of a selection in it. See src/core/textFragment.ts.
 *
 * - Text of elements that aren't rendered (display: none, <script>, <select>...) is left
 *   out; visibility: hidden text too.
 * - Whitespace collapses to one space, except where the page preserves it (<pre>).
 * - Every element that isn't laid out inline (blocks, list items, table cells, inline
 *   blocks, flex items) and every <br> or preserved line break starts a new block ("\n"):
 *   directive terms never cross one. Being stricter than the browser here is safe.
 * - Formulas are block boundaries too: their rendered text (glyphs, hidden MathML) is not
 *   something to put in a link.
 */

const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'select', 'option', 'optgroup', 'datalist',
  'textarea', 'iframe', 'frame', 'object', 'embed', 'canvas', 'video', 'audio', 'img', 'input', 'button', 'svg',
]);
const INVISIBLE = /[​⁠﻿­᠎⁡-⁤]/;
const SPACE = /[ \t\n\r\f   ]/;
const MAX_CHARS = 5_000_000;

export function pageTextModel(doc: Document, range: Range): PageTextModel | null {
  const view = doc.defaultView;
  const root = doc.body ?? doc.documentElement;
  if (!view || !root) return null;

  let out = '';
  let pendingSpace = false;
  let start = -1;
  let end = -1;
  let overflow = false;

  const boundary = () => {
    pendingSpace = false;
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const markBoundaryIn = (node: Node) => {
    if (start === -1 && node.contains(range.startContainer)) start = out.length;
    if (end === -1 && node.contains(range.endContainer)) end = out.length;
  };

  const text = (node: Text, preserveSpaces: boolean, preserveBreaks: boolean) => {
    const data = node.data;
    const isStart = node === range.startContainer;
    const isEnd = node === range.endContainer;
    for (let i = 0; i <= data.length; i++) {
      if (isStart && i === range.startOffset) start = out.length;
      if (isEnd && i === range.endOffset) end = out.length;
      if (i === data.length) break;
      const ch = data[i] ?? '';
      if (INVISIBLE.test(ch)) continue;
      if ((ch === '\n' || ch === '\r') && preserveBreaks) {
        boundary();
        continue;
      }
      if (SPACE.test(ch)) {
        if (preserveSpaces) {
          if (out && !out.endsWith('\n')) out += ' ';
        } else pendingSpace = true;
        continue;
      }
      if (pendingSpace && out && !out.endsWith('\n') && !out.endsWith(' ')) out += ' ';
      pendingSpace = false;
      out += ch;
    }
  };

  const walk = (element: Element) => {
    if (overflow) return;
    if (out.length > MAX_CHARS) {
      overflow = true;
      return;
    }
    const tag = element.localName.toLowerCase();
    if (SKIP.has(tag) || tag === 'universal-copy-toast') {
      markBoundaryIn(element);
      return;
    }
    if (element.matches(MATH_SELECTOR)) {
      boundary();
      markBoundaryIn(element);
      boundary();
      return;
    }
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.getPropertyValue('content-visibility') === 'hidden') {
      markBoundaryIn(element);
      return;
    }
    if (tag === 'br') {
      boundary();
      return;
    }
    const display = style.display;
    const block = !(display === 'inline' || display === 'contents' || display.startsWith('ruby'));
    const visible = style.visibility === 'visible';
    const whiteSpace = style.whiteSpace;
    const collapse = style.getPropertyValue('white-space-collapse');
    const preserveSpaces = whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces' || collapse === 'preserve' || collapse === 'break-spaces';
    const preserveBreaks = preserveSpaces || whiteSpace === 'pre-line' || collapse === 'preserve-breaks';

    if (block) boundary();
    const children = element.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (element === range.startContainer && i === range.startOffset) start = out.length;
      if (element === range.endContainer && i === range.endOffset) end = out.length;
      const child = children[i];
      if (!child) continue;
      if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
        if (visible) text(child as Text, preserveSpaces, preserveBreaks);
        else markBoundaryIn(child);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child as Element);
      }
    }
    if (element === range.startContainer && range.startOffset >= children.length) start = out.length;
    if (element === range.endContainer && range.endOffset >= children.length) end = out.length;
    if (block) boundary();
  };

  walk(root);
  if (overflow || start === -1 || end === -1 || end < start) return null;
  return { text: out, start, end };
}
