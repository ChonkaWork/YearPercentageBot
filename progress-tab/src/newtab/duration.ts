import type { DurationToken } from '../core/format';
import { h, renderIfChanged } from '../ui/dom';

/**
 * Writes a duration as "183 d 22 h left": numbers in the text color with tabular digits, units
 * (and the suffix) smaller and muted. Rebuilt only when the text changes.
 */
export function renderDuration(element: HTMLElement, tokens: readonly DurationToken[], suffix = ''): void {
  const key = `${tokens.map((token) => `${token.value} ${token.unit}`).join(' ')}|${suffix}`;
  renderIfChanged(element, key, () => {
    const nodes: Node[] = [];
    tokens.forEach((token, index) => {
      if (index > 0) nodes.push(document.createTextNode(' '));
      nodes.push(document.createTextNode(`${token.value} `), h('span', { class: 'unit', text: token.unit }));
    });
    if (suffix) nodes.push(document.createTextNode(' '), h('span', { class: 'unit', text: suffix }));
    return nodes;
  });
}
