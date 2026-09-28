import { isBlockLike, isElement, type SnapElement, type SnapNode, type SnapText } from './snapshot';
import { removeInvisible } from './text';

/**
 * Prepares a snapshot for conversion, the way a browser renders whitespace:
 * - invisible characters are removed, no-break spaces become spaces
 * - runs of whitespace collapse to one space, and spaces at the start and end of a
 *   block or line disappear
 * - text in <pre> is kept verbatim (code)
 * - other elements whose white-space preserves line breaks (chat messages, comments)
 *   get their line breaks turned into <br> and keep their spaces
 *
 * Returns a new tree; the input is not modified.
 */
export function normalizeTree(nodes: readonly SnapNode[]): SnapNode[] {
  const cloned = nodes.flatMap((node) => cloneClean(node, false, false));
  collapse(cloned);
  return prune(cloned);
}

/** Marks text whose spaces must be kept (inside a white-space: pre-wrap element). */
interface KeptText extends SnapText {
  keep?: true;
}

function cloneClean(node: SnapNode, inCode: boolean, preserve: boolean): SnapNode | SnapNode[] {
  if (!isElement(node)) {
    const value = node.v.replace(/\r\n?/g, '\n');
    if (inCode) return { t: 'text', v: removeInvisible(value) };
    if (!preserve) return { t: 'text', v: removeInvisible(value) };
    // Preserved line breaks become <br>; spaces are kept as they are.
    const parts: SnapNode[] = [];
    removeInvisible(value)
      .replace(/\t/g, ' ')
      .split('\n')
      .forEach((line, index) => {
        if (index > 0) parts.push({ t: 'el', tag: 'br', c: [] });
        if (line) parts.push({ t: 'text', v: line, keep: true } as KeptText);
      });
    return parts;
  }
  const code = inCode || node.tag === 'pre';
  const keep = !code && node.pre === true;
  const children: SnapNode[] = [];
  for (const child of node.c) {
    const result = cloneClean(child, code, keep);
    if (Array.isArray(result)) children.push(...result);
    else children.push(result);
  }
  const copy: SnapElement = { t: 'el', tag: node.tag, c: children };
  if (node.a) copy.a = { ...node.a };
  if (node.block !== undefined) copy.block = node.block;
  if (node.pre !== undefined) copy.pre = node.pre;
  return copy;
}

/** A stand-in for inline content that isn't text (images), so a following space is kept. */
const NON_SPACE: KeptText = { t: 'text', v: 'x', keep: true };
/** Task-list checkboxes render as "[x] ", which already ends with a space. */
const ENDS_WITH_SPACE: KeptText = { t: 'text', v: ' ', keep: true };

function collapse(nodes: SnapNode[]): void {
  // The last text seen on the current line; null at the start of a block or line.
  let previous: KeptText | null = null;

  const boundary = () => {
    if (previous && !previous.keep) previous.v = previous.v.replace(/ +$/, '');
    previous = null;
  };

  const walk = (list: SnapNode[]) => {
    for (const node of list) {
      if (!isElement(node)) {
        const textNode = node as KeptText;
        if (textNode.keep) {
          if (textNode.v) previous = textNode;
          continue;
        }
        let value = textNode.v.replace(/[ \t\n\f\r]+/g, ' ');
        if (value.startsWith(' ') && (previous === null || previous.v.endsWith(' '))) value = value.slice(1);
        textNode.v = value;
        if (value) previous = textNode;
        continue;
      }
      if (node.tag === 'pre') {
        boundary();
        continue;
      }
      if (node.tag === 'br') {
        boundary();
        continue;
      }
      if (node.tag === 'img') {
        previous = NON_SPACE;
        continue;
      }
      if (node.tag === 'input') {
        previous = ENDS_WITH_SPACE;
        continue;
      }
      if (isBlockLike(node)) {
        boundary();
        walk(node.c);
        boundary();
      } else {
        walk(node.c);
      }
    }
  };

  walk(nodes);
  boundary();
}

function prune(nodes: SnapNode[]): SnapNode[] {
  const out: SnapNode[] = [];
  for (const node of nodes) {
    if (!isElement(node)) {
      if (node.v) out.push({ t: 'text', v: node.v });
      continue;
    }
    if (node.tag === 'pre') {
      out.push(node);
      continue;
    }
    node.c = prune(node.c);
    out.push(node);
  }
  return out;
}
