import type { Change, DiffLine } from '../core/types';
import { h } from '../ui/dom';
import { plural } from '../ui/format';

const SIGNS: Record<Exclude<DiffLine['type'], 'skip'>, { sign: string; label: string }> = {
  add: { sign: '+', label: 'Added: ' },
  remove: { sign: '−', label: 'Removed: ' },
  context: { sign: ' ', label: '' },
};

/** Diff of one change. Page text only ever goes into text nodes. */
export function diffView(change: Change): HTMLElement {
  const lines = h('div', { class: 'diff-lines', attrs: { role: 'list', 'aria-label': 'Changed lines', tabindex: '0' } });
  for (const line of change.lines) {
    if (line.type === 'skip') {
      lines.append(h('div', { class: 'diff-skip', attrs: { role: 'listitem' }, text: `⋯ ${plural(line.count ?? 0, 'unchanged line')}` }));
      continue;
    }
    const { sign, label } = SIGNS[line.type];
    lines.append(
      h(
        'div',
        { class: `diff-line diff-${line.type}`, attrs: { role: 'listitem' } },
        h('span', { class: 'diff-sign', text: sign, attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'diff-text' }, label ? h('span', { class: 'visually-hidden', text: label }) : null, line.text || ' '),
      ),
    );
  }

  return h(
    'div',
    { class: 'diff' },
    h(
      'div',
      { class: 'diff-head' },
      h('span', { class: 'diff-summary', text: change.summary }),
      h(
        'span',
        { class: 'diff-counts', attrs: { 'aria-label': `${plural(change.added, 'line')} added, ${plural(change.removed, 'line')} removed` } },
        h('span', { class: 'text-success-emphasis', text: `+${change.added}` }),
        ' ',
        h('span', { class: 'text-danger-emphasis', text: `−${change.removed}` }),
      ),
    ),
    lines,
    change.truncated
      ? h('div', { class: 'diff-skip', text: 'Some changed lines are not shown: the change was too large to keep in full.' })
      : null,
  );
}
