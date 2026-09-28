/**
 * Draws preview parts (see core/preview.ts) the same way everywhere: the popup, the manager
 * and the in-page suggestions. Text goes in as text nodes only.
 */

import type { PreviewPart } from '../core/preview';

export function renderPreview(parts: readonly PreviewPart[]): Node[] {
  return parts.map((part) => {
    if (part.kind === 'text') return document.createTextNode(part.text);
    const element = document.createElement('span');
    if (part.kind === 'caret') {
      element.className = 'caret-mark';
      element.title = 'The caret ends here';
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', 'caret');
      return element;
    }
    element.className = part.kind === 'field' ? 'var-chip is-field' : 'var-chip';
    element.textContent = part.text;
    element.title = part.token;
    return element;
  });
}
