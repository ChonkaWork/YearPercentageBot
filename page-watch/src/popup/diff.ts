import type { Change, DiffLine } from '../core/types';
import { shortSwap, wordDiff, type WordPart } from '../core/words';
import { h, icon } from '../ui/dom';
import { plural } from '../ui/format';
import { ICONS } from '../ui/icons';

const SIGNS: Record<Exclude<DiffLine['type'], 'skip'>, { sign: string; label: string }> = {
  add: { sign: '+', label: 'Added: ' },
  remove: { sign: '−', label: 'Removed: ' },
  context: { sign: ' ', label: '' },
};

export interface DiffViewOptions {
  /** Noise rules still in use, by id, with their kind: their ignored lines get "Watch … again". */
  activeRules?: ReadonlyMap<string, 'segment' | 'block' | 'order'>;
  onUnignore?(ruleId: string): void;
}

function words(parts: readonly WordPart[], tag: 'del' | 'ins'): Node[] {
  return parts.map((part) => (part.changed ? h(tag, { text: part.text }) : document.createTextNode(part.text)));
}

/** Short regions: the words that changed, large, before → after. */
function wordView(before: string, after: string): HTMLElement {
  const diff = wordDiff(before, after);
  return h(
    'div',
    { class: 'diff-words', attrs: { role: 'group', 'aria-label': 'Before and after' } },
    h('span', { class: 'diff-before' }, h('span', { class: 'visually-hidden', text: 'Before: ' }), ...words(diff.before, 'del')),
    h('span', { class: 'diff-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'diff-after' }, h('span', { class: 'visually-hidden', text: 'After: ' }), ...words(diff.after, 'ins')),
  );
}

/** Where the noise filter explained lines: greyed, with a way to watch them again. */
function ignoredNote(ruleId: string, options: DiffViewOptions): HTMLElement {
  const kind = options.activeRules?.get(ruleId);
  const note = h(
    'div',
    { class: 'diff-note', attrs: { role: 'listitem' } },
    icon(ICONS.ignored),
    h('span', { class: 'me-auto', text: 'Ignored: changes on every check' }),
  );
  if (kind && options.onUnignore) {
    note.append(
      h('button', {
        class: 'btn btn-link btn-sm p-0',
        text: kind === 'segment' ? 'Watch this line again' : 'Watch these lines again',
        attrs: { type: 'button', 'data-focus': `unignore-${ruleId}` },
        on: { click: () => options.onUnignore!(ruleId) },
      }),
    );
  } else if (!kind) {
    note.append(h('span', { class: 'text-body-secondary', text: 'Watched again' }));
  }
  return note;
}

/** Diff of one change. Page text only ever goes into text nodes. */
export function diffView(change: Change, options: DiffViewOptions = {}): HTMLElement {
  const swap = shortSwap(change.lines);
  let body: HTMLElement;
  if (swap) {
    body = wordView(swap.before, swap.after);
  } else {
    body = h('div', { class: 'diff-lines', attrs: { role: 'list', 'aria-label': 'Changed lines', tabindex: '0' } });
    change.lines.forEach((line, index) => {
      if (line.type === 'skip') {
        body.append(h('div', { class: 'diff-skip', attrs: { role: 'listitem' }, text: `⋯ ${plural(line.count ?? 0, 'unchanged line')}` }));
        return;
      }
      const { sign, label } = SIGNS[line.type];
      const hidden = line.ignored ? `Ignored, ${label.toLowerCase()}` : label;
      body.append(
        h(
          'div',
          { class: `diff-line diff-${line.type}${line.ignored ? ' diff-ignored' : ''}`, attrs: { role: 'listitem' } },
          h('span', { class: 'diff-sign', text: sign, attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'diff-text' }, hidden ? h('span', { class: 'visually-hidden', text: hidden }) : null, line.text || ' '),
        ),
      );
      // One note after each run of lines the same rule explained.
      if (line.ignored && change.lines[index + 1]?.ignored !== line.ignored) body.append(ignoredNote(line.ignored, options));
    });
  }

  const head = h('div', { class: 'diff-head' }, h('span', { class: 'diff-summary', text: change.summary }));
  if (!swap) {
    head.append(
      h(
        'span',
        { class: 'diff-counts', attrs: { 'aria-label': `${plural(change.added, 'line')} added, ${plural(change.removed, 'line')} removed` } },
        h('span', { class: 'text-success-emphasis', text: `+${change.added}` }),
        ' ',
        h('span', { class: 'text-danger-emphasis', text: `−${change.removed}` }),
      ),
    );
  }
  return h(
    'div',
    { class: 'diff' },
    head,
    body,
    change.truncated ? h('div', { class: 'diff-skip', text: 'Some changed lines are not shown: the change was too large to keep in full.' }) : null,
  );
}
