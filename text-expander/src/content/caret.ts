/** Where the caret is on screen, for placing the fill-in form and the suggestions next to it. */

import { createHost } from './host';

const MIRRORED = [
  'boxSizing',
  'width',
  'height',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'direction',
] as const;

/**
 * Viewport rectangle of the caret at `position` in an input or textarea. Inputs have no API
 * for it, so a hidden copy with the same box and font is laid out inside our own shadow root
 * (the page's DOM is never touched).
 */
export function fieldCaretRect(element: HTMLInputElement | HTMLTextAreaElement, position: number): DOMRect {
  const box = element.getBoundingClientRect();
  try {
    const { host, root } = createHost('snippets-measure');
    const style = getComputedStyle(element);
    const mirror = document.createElement('div');
    mirror.className = 'caret-mirror';
    for (const property of MIRRORED) mirror.style[property] = style[property];
    mirror.style.left = `${box.left}px`;
    mirror.style.top = `${box.top}px`;
    const textarea = element instanceof HTMLTextAreaElement;
    mirror.style.whiteSpace = textarea ? 'pre-wrap' : 'pre';
    mirror.style.overflowWrap = textarea ? 'break-word' : 'normal';
    mirror.textContent = element.value.slice(0, position);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.append(marker);
    root.append(mirror);
    document.documentElement.append(host);
    const rect = marker.getBoundingClientRect();
    host.remove();
    const left = Math.min(Math.max(rect.left - element.scrollLeft, box.left), box.right);
    const top = Math.min(Math.max(rect.top - element.scrollTop, box.top), box.bottom - rect.height);
    return new DOMRect(left, top, 1, rect.height || box.height);
  } catch {
    return new DOMRect(box.left, box.bottom - 1, 1, 1);
  }
}

/** Viewport rectangle of a collapsed range in a rich editor, falling back to the editor's box. */
export function rangeCaretRect(range: Range, element: HTMLElement): DOMRect {
  const rect = range.getBoundingClientRect();
  if (rect.height > 0 || rect.left > 0 || rect.top > 0) return rect;
  const first = range.getClientRects()[0];
  if (first) return first;
  const box = element.getBoundingClientRect();
  return new DOMRect(box.left, box.top, 1, Math.min(box.height, 20));
}
