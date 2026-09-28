import { combineHeaderRows } from '../core/table';
import { h } from '../ui/dom';
import { plural } from '../ui/format';

/**
 * A small preview of a table: one header row exactly as it will be exported (grouped
 * headers combined: "Population / 2010") and the first body rows. As many columns as fit
 * without cutting a header; the rest are summed up as "+N columns". Full values are in
 * each cell's title.
 */

export interface PreviewInput {
  rows: string[][];
  headerRows: number;
  /** Columns of the whole table (the rows may hold fewer). */
  columns: number;
  bodyRows?: number;
}

export function previewBlock(input: PreviewInput, className = ''): HTMLElement {
  const width = input.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const labels = input.headerRows > 0 ? combineHeaderRows({ rows: input.rows, headerRows: input.headerRows, width, truncated: false }) : [];
  const body = input.rows.slice(input.headerRows, input.headerRows + (input.bodyRows ?? 3));
  const cell = (tag: 'th' | 'td', value: string) => {
    const flat = value.replace(/\s*\n\s*/g, ' ');
    return h(tag, { attrs: { title: flat } }, h('span', { class: 'cell', text: flat }));
  };
  const table = h('table', { class: 'table table-sm' });
  if (labels.length) table.append(h('thead', {}, h('tr', {}, ...labels.map((label, column) => cell('th', label || `Column ${column + 1}`)))));
  table.append(h('tbody', {}, ...body.map((row) => h('tr', {}, ...Array.from({ length: width }, (_, column) => cell('td', row[column] ?? ''))))));
  const block = h(
    'div',
    { class: `preview-block ${className}`.trim(), attrs: { 'data-columns': String(input.columns), 'data-labels': JSON.stringify(labels) } },
    h('div', { class: 'table-preview', attrs: { 'aria-hidden': 'true' } }, table),
    h('div', { class: 'more-columns', attrs: { hidden: '' } }),
  );
  return block;
}

/**
 * Hides trailing columns that don't fit (the block must be in the document) and says how
 * many are left out. Safe to call again after the popup's width changes.
 */
export function fitPreviews(root: ParentNode): void {
  for (const block of Array.from(root.querySelectorAll<HTMLElement>('.preview-block'))) {
    const wrap = block.querySelector<HTMLElement>('.table-preview');
    const table = wrap?.querySelector('table');
    const note = block.querySelector<HTMLElement>('.more-columns');
    if (!wrap || !table || !note || wrap.clientWidth === 0) continue;
    const rows = Array.from(table.rows);
    for (const row of rows) for (const cell of Array.from(row.cells)) cell.hidden = false;
    let shown = rows[0]?.cells.length ?? 0;
    while (shown > 1 && table.offsetWidth > wrap.clientWidth) {
      shown--;
      for (const row of rows) {
        const cell = row.cells[shown];
        if (cell) cell.hidden = true;
      }
    }
    const total = Number(block.dataset.columns) || shown;
    const hidden = Math.max(0, total - shown);
    note.hidden = hidden === 0;
    note.textContent = `+${hidden} ${plural(hidden, 'column')}`;
    let labels: string[] = [];
    try {
      labels = JSON.parse(block.dataset.labels ?? '[]') as string[];
    } catch {
      labels = [];
    }
    const names = labels.slice(shown).filter(Boolean);
    note.title = names.length ? `Not shown: ${names.join(', ')}${total > labels.length ? ', …' : ''}` : '';
  }
}
