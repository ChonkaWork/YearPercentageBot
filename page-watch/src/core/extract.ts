import { collapseSpaces, normalizeText } from './normalize';

/**
 * Turns a DOM subtree into plain text, one line per block element. Works the same on a
 * document parsed with DOMParser (no layout, scripts never run) and on a live page, so the
 * text the picker shows matches what later checks produce.
 *
 * Only reads text: nothing from the page is ever turned back into markup.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

/** Never visible or never meaningful as text. */
const SKIPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
  'iframe',
  'frame',
  'object',
  'embed',
  'video',
  'audio',
  'picture',
  'img',
  'head',
  'title',
  'meta',
  'link',
  'base',
  'textarea',
  'input',
  'datalist',
]);

const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'html',
  'legend',
  'li',
  'main',
  'nav',
  'ol',
  'option',
  'p',
  'pre',
  'section',
  'select',
  'summary',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'ul',
]);

const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i;

/** Hidden by markup alone. Computed styles aren't available in parsed documents, so they aren't used on live pages either. */
export function isHiddenElement(element: Element): boolean {
  const tag = element.localName;
  if (SKIPPED.has(tag)) return true;
  const hidden = element.getAttribute('hidden');
  if (hidden !== null && hidden !== 'until-found') return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  if (tag === 'dialog' && !element.hasAttribute('open')) return true;
  const style = element.getAttribute('style');
  return style !== null && HIDDEN_STYLE.test(style);
}

const MAX_DEPTH = 400;

/** Plain text of an element (or a whole document body), normalized into stable lines. */
export function extractText(root: Node): string {
  const out: string[] = [];
  if (root.nodeType === ELEMENT_NODE && (root as Element).localName === 'tr') {
    out.push(rowText(root as Element));
  } else {
    walk(root, out, false, 0);
  }
  return normalizeText(out.join(''));
}

function walk(node: Node, out: string[], inPre: boolean, depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
      const data = (child as CharacterData).data;
      // HTML collapses source whitespace (including newlines) except inside <pre>.
      out.push(inPre ? data : data.replace(/\s+/g, ' '));
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const element = child as Element;
    if (isHiddenElement(element)) continue;
    const tag = element.localName;
    if (tag === 'br') {
      out.push('\n');
    } else if (tag === 'tr') {
      out.push('\n', rowText(element), '\n');
    } else if (BLOCKS.has(tag)) {
      out.push('\n');
      walk(element, out, inPre || tag === 'pre', depth + 1);
      out.push('\n');
    } else {
      walk(element, out, inPre, depth + 1);
    }
  }
}

/** A table row becomes one line: "Pro | $29/mo | 10 users". */
function rowText(row: Element): string {
  const cells: string[] = [];
  for (let cell = row.firstElementChild; cell; cell = cell.nextElementSibling) {
    if (cell.localName !== 'td' && cell.localName !== 'th') continue;
    if (isHiddenElement(cell)) continue;
    const parts: string[] = [];
    walk(cell, parts, false, 0);
    const text = collapseSpaces(parts.join(' '));
    if (text) cells.push(text);
  }
  return cells.join(' | ');
}
