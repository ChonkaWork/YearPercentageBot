import { changeKinds, invisibleName, limitSegments, type ChangeKind, type Segment } from '../core/changes';
import { h } from './dom';

/**
 * Renders the annotated text of "Show changes": what stayed as plain text, removals struck
 * through (tracking parameters, rules, Markdown...), invisible characters as small labelled
 * markers, merged line breaks as ↵ and removed spaces as ·, additions underlined. Page
 * content only ever becomes text nodes.
 */

const REMOVED_LABEL: Record<ChangeKind, string> = {
  invisible: 'Invisible character removed',
  whitespace: 'Extra space removed',
  'line-break': 'Line break merged',
  bullet: 'Bullet removed',
  tracking: 'Tracking parameter removed',
  typography: 'Replaced by a plain character',
  markdown: 'Markdown syntax removed',
  rule: 'Removed by a custom rule',
};

const ADDED_LABEL: Record<ChangeKind, string> = {
  invisible: 'Added',
  whitespace: 'Added',
  'line-break': 'Space that joins the lines',
  bullet: 'Added',
  tracking: 'Added',
  typography: 'Plain character',
  markdown: 'Plain list bullet',
  rule: 'Added by a custom rule',
};

export function renderChanges(target: HTMLElement, segments: readonly Segment[], maxChars: number): { truncated: boolean } {
  const { segments: shown, truncated } = limitSegments(segments, maxChars);
  const nodes: Node[] = [];
  for (const segment of shown) {
    if (!segment.op || !segment.kind) {
      nodes.push(document.createTextNode(segment.text));
    } else if (segment.op === 'ins') {
      // The space that joins merged lines needs no highlight: the ↵ before it says it all.
      if (segment.kind === 'line-break' || segment.kind === 'whitespace') nodes.push(document.createTextNode(segment.text));
      else nodes.push(h('ins', { class: `chg chg-ins chg-${segment.kind}`, text: segment.text, attrs: { title: ADDED_LABEL[segment.kind] } }));
    } else {
      nodes.push(removed(segment.text, segment.kind));
    }
  }
  if (truncated) nodes.push(h('span', { class: 'chg-more', text: ' …' }));
  target.replaceChildren(...nodes);
  return { truncated };
}

function removed(text: string, kind: ChangeKind): HTMLElement {
  const del = h('del', { class: `chg chg-del chg-${kind}`, attrs: { title: REMOVED_LABEL[kind] } });
  if (kind === 'invisible') {
    for (const char of text) {
      const name = invisibleName(char);
      del.append(h('span', { class: 'chg-marker', text: name.short, attrs: { title: `Removed: ${name.name}` } }));
    }
    return del;
  }
  if (kind === 'whitespace' || kind === 'line-break') {
    del.classList.add('chg-symbols');
    del.textContent = text.replace(/\n/g, '↵').replace(/\t/g, '→').replace(/ /g, '·');
    return del;
  }
  // Removed text keeps its words; a removed line break shows as ↵ so the layout stays the result's.
  del.textContent = text.replace(/\n/g, '↵');
  return del;
}

/** A one-line key to the marks used, only for the marks present. */
export function renderLegend(target: HTMLElement, segments: readonly Segment[]): void {
  const kinds = new Set(changeKinds(segments));
  const marks = new Set(['invisible', 'whitespace', 'line-break']);
  const items: HTMLElement[] = [];
  const key = (sample: HTMLElement, label: string) => {
    sample.setAttribute('aria-hidden', 'true');
    return h('span', { class: 'chg-key' }, sample, h('span', { text: label }));
  };
  if (segments.some((segment) => segment.op === 'del' && segment.kind && !marks.has(segment.kind))) {
    items.push(key(h('del', { class: 'chg chg-del chg-sample', text: 'text' }), 'removed'));
  }
  if (segments.some((segment) => segment.op === 'ins' && segment.kind && !marks.has(segment.kind))) {
    items.push(key(h('ins', { class: 'chg chg-ins chg-sample', text: 'text' }), 'added'));
  }
  if (kinds.has('invisible')) items.push(key(h('span', { class: 'chg-marker', text: 'ZWSP' }), 'invisible character'));
  if (kinds.has('line-break')) items.push(key(h('del', { class: 'chg chg-del chg-symbols chg-sample', text: '↵' }), 'lines joined'));
  if (kinds.has('whitespace')) items.push(key(h('del', { class: 'chg chg-del chg-symbols chg-sample', text: '·' }), 'extra space'));
  target.hidden = items.length === 0;
  target.replaceChildren(...items);
}
