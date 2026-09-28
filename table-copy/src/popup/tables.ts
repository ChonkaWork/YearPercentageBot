import basketIcon from 'bootstrap-icons/icons/basket.svg';
import columnsIcon from 'bootstrap-icons/icons/layout-three-columns.svg';
import recordIcon from 'bootstrap-icons/icons/record-circle.svg';
import tableIcon from 'bootstrap-icons/icons/table.svg';
import { basketItemFrom } from '../core/basket';
import { initialColumns, pickColumns, selectedColumns, type ColumnState } from '../core/columns';
import { expandLinks, withoutLinks } from '../core/links';
import { limitsFor } from '../core/plan';
import type { TableData } from '../core/table';
import type { TableRead } from '../page/index';
import { PREVIEW_BODY_ROWS, PREVIEW_COLUMNS, type TableList, type TableSummary } from '../page/reader';
import { callPage } from '../platform/page';
import { addBasketItem, newItemId } from '../storage/store';
import { byId, h } from '../ui/dom';
import { basketFailure, formatCount, plural, tableSize } from '../ui/format';
import { allowed, announce, busy, emptyState, flash, iconButton, isLocked, showNotice, state } from './context';
import { exportControl, type ExportControl, type ExportJob } from './export';
import { createPicker } from './picker';
import { connectHighlight, setFocus, setHover } from './highlight';
import { fitPreviews, previewBlock } from './preview';
import { renderBasket } from './basket';
import { startRecording } from './recording';

/** The list of tables on the page: one card per table, with its preview and actions. */

const els = {
  section: byId<HTMLElement>('tables-section'),
  tables: byId<HTMLDivElement>('tables'),
  count: byId<HTMLSpanElement>('tables-count'),
};

/** Per listed table: its summary, and the column picker once opened. */
export interface Entry {
  summary: TableSummary;
  name: string;
  element: HTMLElement;
  control: ExportControl | null;
  /** Full table, read when the picker is opened. */
  data: TableData | null;
  columns: ColumnState | null;
}

const entries = new Map<number, Entry>();

export function renderLoading(): void {
  const line = (width: string) => h('span', { class: `placeholder d-block mb-1 rounded w-${width}` });
  els.tables.replaceChildren(
    ...[0, 1].map(() =>
      h(
        'div',
        { class: 'list-group-item table-skeleton placeholder-glow', attrs: { 'aria-hidden': 'true' } },
        line('50'),
        h('span', { class: 'placeholder d-block w-100 rounded mt-2', attrs: { style: 'height: 4.5rem' } }),
        h('span', { class: 'placeholder d-block w-100 rounded mt-2', attrs: { style: 'height: 1.75rem' } }),
      ),
    ),
  );
  announce('Reading the page…');
}

export function hideTables(): void {
  els.section.hidden = true;
}

export function renderTables(list: TableList): void {
  els.count.hidden = list.total === 0;
  els.count.textContent = formatCount(list.total);
  entries.clear();
  if (list.total === 0) {
    els.tables.replaceChildren(emptyState(tableIcon, 'No tables on this page.', 'list-group-item'));
    announce('No tables on this page.');
    return;
  }
  const items = list.tables.map((summary, position) => tableItem(summary, position + 1));
  if (list.total > list.tables.length) {
    items.push(h('div', { class: 'list-group-item small text-body-secondary', text: `Showing the first ${list.tables.length} of ${formatCount(list.total)} tables.` }));
  }
  els.tables.replaceChildren(...items);
  fitPreviews(els.tables);
  announce(`${list.total} ${plural(list.total, 'table')} on this page.`);
  connectHighlight();
}

function tableItem(summary: TableSummary, position: number): HTMLElement {
  const name = summary.title || `Table ${position}`;
  const element = h('div', { class: 'list-group-item table-item', attrs: { 'data-index': String(summary.index) } });
  const entry: Entry = { summary, name, element, control: null, data: null, columns: null };
  entries.set(summary.index, entry);

  const control = exportControl(name, () => loadEntry(entry));
  entry.control = control;
  const columns = iconButton('columns', columnsIcon, `Choose columns of ${name}`, 'Columns · Pro', isLocked('column-picker'));
  columns.setAttribute('aria-expanded', 'false');
  columns.addEventListener('click', () => void toggleColumns(entry, columns));
  const record = iconButton('record', recordIcon, `Record rows of ${name}`, 'Record rows · Pro', isLocked('record-rows'));
  record.addEventListener('click', () => void startRecording(entry.summary, name, record));
  const basket = iconButton('basket', basketIcon, `Add ${name} to the basket`, 'Add to basket · Pro', isLocked('merge-tables'));
  basket.addEventListener('click', () => void addTableToBasket(entry, basket));

  const dims = h('span', { class: 'table-dims mono ms-auto', text: `${formatCount(summary.rows)} × ${formatCount(summary.columns)}`, attrs: { title: tableSize(summary.rows, summary.columns) } });
  element.append(
    h('div', { class: 'd-flex align-items-baseline gap-2' }, h('span', { class: 'table-title text-truncate', text: name, attrs: { title: name } }), dims),
    h('div', { class: 'preview-slot' }),
  );
  // Virtualized grids show a window of their rows: point at Record rows.
  if (summary.declaredRows && summary.declaredRows > summary.rows) {
    const shown = Math.max(0, summary.rows - summary.headerRows);
    const total = Math.max(shown, summary.declaredRows - summary.headerRows);
    const link = h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', text: 'Record rows', attrs: { type: 'button' } });
    link.addEventListener('click', () => void startRecording(entry.summary, name, record));
    element.append(h('div', { class: 'rows-hint' }, `Only ${formatCount(shown)} of ${formatCount(total)} rows are loaded. `, link, ' collects them as you scroll.'));
  }
  element.append(h('div', { class: 'table-actions' }, control.element, columns, record, basket));
  renderPreview(entry);

  element.addEventListener('mouseenter', () => setHover(summary));
  element.addEventListener('mouseleave', () => setHover(null, summary));
  element.addEventListener('focusin', () => setFocus(summary));
  element.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) setFocus(null, summary);
  });
  return element;
}

/** Preview of the first rows: from the listing, or from the full table with the picked columns. */
function renderPreview(entry: Entry): void {
  const slot = entry.element.querySelector<HTMLElement>('.preview-slot');
  if (!slot) return;
  if (entry.data && entry.columns) {
    const picked = pickColumns(entry.data, selectedColumns(entry.columns));
    if (picked.width === 0) {
      slot.replaceChildren(h('div', { class: 'table-preview empty-preview', text: 'No columns selected' }));
      return;
    }
    const rows = picked.rows.slice(0, picked.headerRows + PREVIEW_BODY_ROWS).map((row) => row.slice(0, PREVIEW_COLUMNS).map(shortCell));
    slot.replaceChildren(previewBlock({ rows, headerRows: picked.headerRows, columns: picked.width }));
  } else {
    slot.replaceChildren(previewBlock({ rows: entry.summary.preview, headerRows: entry.summary.headerRows, columns: entry.summary.columns }));
  }
  if (slot.isConnected) fitPreviews(slot);
}

function shortCell(value: string): string {
  const flat = value.replace(/\s*\n\s*/g, ' ');
  return flat.length > 48 ? `${flat.slice(0, 47).trimEnd()}…` : flat;
}

type ReadOk = Extract<TableRead, { status: 'ok' }>;

/**
 * Reads the table fresh from the page (it may have changed since the popup opened) and
 * applies the column picker. Reports problems itself and returns null.
 */
async function readEntry(entry: Entry): Promise<{ read: ReadOk; data: TableData } | null> {
  if (state.tabId === null) return null;
  let read: TableRead;
  try {
    read = await callPage(state.tabId, 0, 'readTableAt', entry.summary.index, entry.summary.signature);
  } catch {
    showNotice('error', "Couldn't read the table", 'The page may have changed or navigated away. Reopen the popup and try again.');
    return null;
  }
  if (read.status !== 'ok') {
    showNotice('error', 'This table has changed', 'The page updated since the popup opened. Reopen the popup to copy the current table.');
    return null;
  }
  let data = read.data;
  if (entry.columns) {
    if (entry.data && entry.data.width !== data.width) {
      showNotice('error', 'This table has changed', 'Its columns changed since you picked them. Reopen the popup and pick again.');
      return null;
    }
    data = pickColumns(data, selectedColumns(entry.columns));
  }
  if (data.rows.length === 0) {
    showNotice('error', entry.columns ? 'No columns selected' : 'This table is empty', entry.columns ? 'Pick at least one column.' : 'It has no visible text to copy.');
    return null;
  }
  return { read, data };
}

async function loadEntry(entry: Entry): Promise<ExportJob | null> {
  const found = await readEntry(entry);
  if (!found) return null;
  return {
    name: entry.name,
    file: entry.summary.title || found.read.page.pageTitle,
    data: found.data,
    decimal: found.read.page.decimal,
    note: entry.columns ? ' (picked columns)' : '',
  };
}

async function addTableToBasket(entry: Entry, button: HTMLButtonElement): Promise<void> {
  if (!allowed('merge-tables')) return;
  await busy(button, async () => {
    const found = await readEntry(entry);
    if (!found) return;
    const page = found.read.page;
    const data = state.settings.keepLinks ? expandLinks(found.data) : withoutLinks(found.data);
    const item = basketItemFrom(data, { title: entry.summary.title, pageTitle: page.pageTitle, url: page.url, decimal: page.decimal }, newItemId(), Date.now());
    let result;
    try {
      result = await addBasketItem(item);
    } catch {
      showNotice('error', "Couldn't save the basket", 'Please try again.');
      return;
    }
    if (!result.ok) {
      const failure = basketFailure(result.reason, limitsFor(state.plan).basketTables);
      showNotice(result.reason === 'duplicate' ? 'info' : 'error', failure.title, failure.detail);
      return;
    }
    state.basket = result.items;
    renderBasket();
    flash(button, `Added ${entry.name} to the basket`, true);
    announce(`Added ${entry.name} to the basket: ${state.basket.length} ${plural(state.basket.length, 'table')}.`);
  });
}

// --- Column picker ----------------------------------------------------------------------

async function toggleColumns(entry: Entry, button: HTMLButtonElement): Promise<void> {
  if (!allowed('column-picker')) return;
  const open = entry.element.querySelector('.column-picker');
  if (open) {
    open.remove();
    button.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  if (!entry.data) {
    const ok = await busy(button, async () => {
      if (state.tabId === null) return false;
      let read: TableRead;
      try {
        read = await callPage(state.tabId, 0, 'readTableAt', entry.summary.index, entry.summary.signature);
      } catch {
        showNotice('error', "Couldn't read the table", 'The page may have changed or navigated away. Reopen the popup and try again.');
        return false;
      }
      if (read.status !== 'ok') {
        showNotice('error', 'This table has changed', 'The page updated since the popup opened. Reopen the popup to see the current table.');
        return false;
      }
      entry.data = read.data;
      entry.columns = initialColumns(read.data.width);
      return true;
    });
    if (!ok) return;
  }
  const data = entry.data;
  const columns = entry.columns;
  if (!data || !columns) return;
  button.classList.add('active');
  button.setAttribute('aria-expanded', 'true');
  const picker = createPicker({
    key: String(entry.summary.index),
    name: entry.name,
    data,
    columns,
    changed: () => {
      renderPreview(entry);
      const empty = selectedColumns(columns).length === 0;
      entry.control?.setDisabled(empty);
      for (const action of entry.element.querySelectorAll<HTMLButtonElement>('[data-action="basket"], [data-action="record"]')) action.disabled = empty;
    },
  });
  entry.element.append(picker);
  renderPreview(entry);
  picker.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
}
