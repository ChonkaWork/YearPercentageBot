import downIcon from 'bootstrap-icons/icons/arrow-down.svg';
import upIcon from 'bootstrap-icons/icons/arrow-up.svg';
import basketIcon from 'bootstrap-icons/icons/basket.svg';
import checkIcon from 'bootstrap-icons/icons/check2.svg';
import successIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import warningIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import spreadsheetIcon from 'bootstrap-icons/icons/file-earmark-spreadsheet.svg';
import gearIcon from 'bootstrap-icons/icons/gear.svg';
import infoIcon from 'bootstrap-icons/icons/info-circle-fill.svg';
import keyboardIcon from 'bootstrap-icons/icons/keyboard.svg';
import columnsIcon from 'bootstrap-icons/icons/layout-three-columns.svg';
import tableIcon from 'bootstrap-icons/icons/table.svg';
import removeIcon from 'bootstrap-icons/icons/x-lg.svg';
import { basketItemFrom, basketSheets, cellCount, itemHost, itemLabel, mergeBasket, type BasketItem } from '../core/basket';
import { columnLabels, columnSample, initialColumns, moveColumn, pickColumns, selectedColumns, type ColumnState } from '../core/columns';
import { fileName, FORMAT_LABELS, formatTable, TABLE_FORMATS, type ClipboardPayload, type TableFormat } from '../core/formats';
import { FEATURE_LABELS, hasFeature, limitsFor, upgradeMessage, type Plan, type ProFeature } from '../core/plan';
import { defaultSettings, type MergeLayout, type Settings } from '../core/settings';
import type { TableData } from '../core/table';
import { buildXlsx, XLSX_MIME } from '../core/xlsx';
import type { PageInfo, TableRead } from '../page/index';
import { PREVIEW_COLUMNS, PREVIEW_ROWS, type TableList, type TableSummary } from '../page/reader';
import type { CopyRequest } from '../platform/messages';
import { callPage } from '../platform/page';
import { addBasketItem, clearBasket, loadBasket, loadPlan, loadSettings, newItemId, removeBasketItem, saveSettings, takeNotice } from '../storage/store';
import { copyFromPage } from '../ui/clipboard';
import { byId, h } from '../ui/dom';
import { downloadBytes } from '../ui/download';
import { basketFailure, formatCount, plural, tableSize } from '../ui/format';
import { svgIcon } from '../ui/icons';

const COMMAND = '_execute_action';

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  notice: byId<HTMLDivElement>('notice'),
  tablesSection: byId<HTMLElement>('tables-section'),
  tables: byId<HTMLDivElement>('tables'),
  tablesCount: byId<HTMLSpanElement>('tables-count'),
  basket: byId<HTMLDivElement>('basket'),
  basketCount: byId<HTMLSpanElement>('basket-count'),
  shortcutIcon: byId<HTMLSpanElement>('shortcut-icon'),
  shortcutText: byId<HTMLSpanElement>('shortcut-text'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  status: byId<HTMLDivElement>('status'),
};

let tabId: number | null = null;
let settings: Settings = defaultSettings();
let plan: Plan = 'free';
let basket: BasketItem[] = [];

/** Per listed table: its summary, and the column picker once opened. */
interface Entry {
  summary: TableSummary;
  name: string;
  element: HTMLElement;
  /** Full table, read when the picker is opened. */
  data: TableData | null;
  columns: ColumnState | null;
}

const entries = new Map<number, Entry>();

// --- Setup ------------------------------------------------------------------------------

async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  if (__E2E__) {
    // Tests open the popup as a normal page and point it at a fixture tab.
    const forced = Number(new URLSearchParams(location.search).get('tabId'));
    if (forced) return chrome.tabs.get(forced);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init(): Promise<void> {
  els.openOptions.append(svgIcon(gearIcon, 16));
  els.shortcutIcon.append(svgIcon(keyboardIcon, 14));
  renderLoading();

  const [notice, loaded, loadedPlan, loadedBasket, tab] = await Promise.all([takeNotice(), loadSettings(), loadPlan(), loadBasket(), targetTab()]);
  settings = loaded;
  plan = loadedPlan;
  basket = loadedBasket;
  void renderShortcut();
  renderBasket();
  if (notice) showNotice(notice.tone, notice.title, notice.detail, 'stored');
  void clearBadge(tab?.id);

  if (tab?.id === undefined) return renderUnreadable();
  tabId = tab.id;
  let list: TableList;
  try {
    list = await callPage(tab.id, 0, 'listTables');
  } catch {
    return renderUnreadable();
  }
  renderTables(list);
}

function renderLoading(): void {
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
  els.status.textContent = 'Reading the page…';
}

function renderUnreadable(): void {
  els.tablesSection.hidden = true;
  els.status.textContent = "This page can't be read.";
  // A message left by the background already explains it.
  if (els.notice.querySelector('[data-key="stored"]')) return;
  showNotice(
    'warning',
    "Table Copy can't read this page",
    "Chrome doesn't let extensions read chrome:// pages, the Chrome Web Store or the PDF viewer. Open a regular web page and try again.",
    'page',
    false,
  );
}

async function clearBadge(id: number | undefined): Promise<void> {
  try {
    await chrome.action.setBadgeText(id !== undefined ? { tabId: id, text: '' } : { text: '' });
  } catch {
    // Nothing to clear.
  }
}

async function renderShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((command) => command.name === COMMAND)?.shortcut;
    if (shortcut) els.shortcutText.replaceChildren(h('kbd', { text: shortcut }), ' opens Table Copy');
    else els.shortcutText.textContent = 'No keyboard shortcut set';
  } catch {
    els.shortcutText.textContent = 'Keyboard shortcut unavailable';
  }
}

// --- Notices ----------------------------------------------------------------------------

type Tone = 'success' | 'error' | 'info' | 'warning';

/**
 * Alerts at the top of the popup. Each key holds one alert, so the page state ("can't read
 * this page"), a message left by the background and the latest error can coexist.
 */
function showNotice(tone: Tone, title: string, detail?: string, key = 'message', dismissible = true, action?: HTMLElement): void {
  const variant = { success: 'success', error: 'danger', info: 'primary', warning: 'warning' }[tone];
  const iconSource = { success: successIcon, error: errorIcon, info: infoIcon, warning: warningIcon }[tone];
  const alert = h(
    'div',
    {
      class: `alert alert-${variant} d-flex align-items-start gap-2 py-2 px-3 small mb-3`,
      attrs: { role: tone === 'error' ? 'alert' : 'status', 'data-key': key },
    },
    svgIcon(iconSource, 16),
    h('div', {}, h('div', { class: 'fw-bold', text: title }), detail ? h('div', { text: detail }) : null, action ?? null),
  );
  if (dismissible) {
    alert.append(h('button', { class: 'btn-close ms-auto', attrs: { type: 'button', 'aria-label': 'Dismiss' }, on: { click: () => alert.remove() } }));
  }
  const existing = els.notice.querySelector(`[data-key="${key}"]`);
  if (existing) existing.replaceWith(alert);
  else els.notice.append(alert);
  els.notice.hidden = false;
  alert.scrollIntoView({ block: 'nearest' });
}

function announce(message: string): void {
  els.status.textContent = message;
}

/** Pro features always go through hasFeature(); a free user gets one calm line and a link. */
function allowed(feature: ProFeature): boolean {
  if (hasFeature(plan, feature)) return true;
  const link = h('button', { class: 'btn btn-link btn-sm p-0 mt-1', text: 'About Pro', attrs: { type: 'button' } });
  link.addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#pro') }));
  showNotice('info', FEATURE_LABELS[feature], upgradeMessage(feature), 'pro', true, link);
  return false;
}

function proBadge(): HTMLElement {
  return h('span', { class: 'badge pro-badge', text: 'PRO', attrs: { title: 'Pro feature' } });
}

// --- Tables -----------------------------------------------------------------------------

function renderTables(list: TableList): void {
  els.tablesCount.hidden = list.total === 0;
  els.tablesCount.textContent = formatCount(list.total);
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
  announce(`${list.total} ${plural(list.total, 'table')} on this page.`);
}

function tableItem(summary: TableSummary, position: number): HTMLElement {
  const name = summary.title || `Table ${position}`;
  const element = h('div', { class: 'list-group-item table-item', attrs: { 'data-index': String(summary.index) } });
  const entry: Entry = { summary, name, element, data: null, columns: null };
  entries.set(summary.index, entry);

  const formatButtons = TABLE_FORMATS.map((format) => {
    const button = h('button', {
      class: 'btn btn-outline-primary',
      text: FORMAT_LABELS[format],
      attrs: {
        type: 'button',
        'data-format': format,
        title: format === 'tsv' ? 'Copy as TSV: pastes into Excel and Google Sheets as cells' : `Copy as ${FORMAT_LABELS[format]}`,
      },
    });
    button.addEventListener('click', () => void copyTable(entry, format, button));
    return button;
  });

  const action = (key: string, icon: string, label: string, title: string, run: (button: HTMLButtonElement) => void) => {
    const button = h('button', { class: 'btn btn-sm btn-action', attrs: { type: 'button', 'data-action': key, title } }, svgIcon(icon, 14), h('span', { text: label }), proBadge());
    if (key === 'columns') button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => run(button));
    return button;
  };

  element.append(
    h(
      'div',
      { class: 'd-flex align-items-baseline gap-2' },
      h('span', { class: 'table-title text-truncate', text: name, attrs: { title: name } }),
      h('span', { class: 'table-dims mono ms-auto', text: `${formatCount(summary.rows)} × ${formatCount(summary.columns)}`, attrs: { title: tableSize(summary.rows, summary.columns) } }),
    ),
    h('div', { class: 'preview-slot' }),
    h('div', { class: 'btn-group btn-group-sm w-100 mt-2 format-buttons', attrs: { role: 'group', 'aria-label': `Copy ${name} as` } }, ...formatButtons),
    h(
      'div',
      { class: 'd-flex gap-1 mt-2 table-actions' },
      action('columns', columnsIcon, 'Columns', 'Choose and reorder columns', (button) => void toggleColumns(entry, button)),
      action('xlsx', spreadsheetIcon, '.xlsx', 'Download as an Excel file', (button) => void downloadTable(entry, button)),
      action('basket', basketIcon, 'Basket', 'Add to the basket to merge with other tables', (button) => void addTableToBasket(entry, button)),
    ),
  );
  renderPreview(entry);
  return element;
}

/** Preview of the first rows: from the listing, or from the full table with the picked columns. */
function renderPreview(entry: Entry): void {
  const slot = entry.element.querySelector('.preview-slot');
  if (!slot) return;
  let rows: string[][];
  let headerRows: number;
  let hiddenColumns: number;
  if (entry.data && entry.columns) {
    const picked = pickColumns(entry.data, selectedColumns(entry.columns));
    rows = picked.rows.slice(0, Math.max(PREVIEW_ROWS, picked.headerRows + 2)).map((row) => row.slice(0, PREVIEW_COLUMNS).map(shortCell));
    headerRows = Math.min(picked.headerRows, rows.length);
    hiddenColumns = picked.width - PREVIEW_COLUMNS;
  } else {
    rows = entry.summary.preview;
    headerRows = entry.summary.headerRows;
    hiddenColumns = entry.summary.columns - PREVIEW_COLUMNS;
  }
  const children: HTMLElement[] = [];
  if (rows.length > 0 && rows[0]?.length) {
    const body = rows.map((row, index) => {
      const header = index < headerRows;
      return h('tr', { class: header ? 'header-row' : '' }, ...row.map((value) => h(header ? 'th' : 'td', { text: value, attrs: { title: value } })));
    });
    children.push(h('div', { class: 'table-preview', attrs: { 'aria-hidden': 'true' } }, h('table', { class: 'table table-sm' }, h('tbody', {}, ...body))));
  } else if (entry.columns) {
    children.push(h('div', { class: 'table-preview empty-preview', text: 'No columns selected' }));
  }
  if (hiddenColumns > 0) children.push(h('div', { class: 'more-columns mt-1', text: `+${hiddenColumns} more ${plural(hiddenColumns, 'column')}` }));
  slot.replaceChildren(...children);
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
  if (tabId === null) return null;
  let read: TableRead;
  try {
    read = await callPage(tabId, 0, 'readTableAt', entry.summary.index, entry.summary.signature);
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

async function copyTable(entry: Entry, format: TableFormat, button: HTMLButtonElement): Promise<void> {
  await busy(button, async () => {
    const found = await readEntry(entry);
    if (!found) return;
    const payload = formatTable(found.data, format, settings);
    const picked = entry.columns ? ' (picked columns)' : '';
    await copyAndConfirm(payload, button, `Copied ${entry.name} as ${FORMAT_LABELS[format]}${picked}: ${tableSize(found.data.rows.length, found.data.width)}.`);
  });
}

async function downloadTable(entry: Entry, button: HTMLButtonElement): Promise<void> {
  if (!allowed('xlsx')) return;
  await busy(button, async () => {
    const found = await readEntry(entry);
    if (!found) return;
    const bytes = buildXlsx([{ name: entry.summary.title || 'Table', rows: found.data.rows, headerRows: found.data.headerRows }], {
      numbers: settings.xlsxNumbers,
      decimal: found.read.page.decimal,
    });
    const name = fileName(entry.summary.title || found.read.page.pageTitle, 'xlsx');
    downloadBytes(bytes, name, XLSX_MIME);
    flash(button, 'Saved');
    announce(`Downloaded ${name}: ${tableSize(found.data.rows.length, found.data.width)}.`);
  });
}

async function addTableToBasket(entry: Entry, button: HTMLButtonElement): Promise<void> {
  if (!allowed('merge-tables')) return;
  await busy(button, async () => {
    const found = await readEntry(entry);
    if (!found) return;
    const page: PageInfo = found.read.page;
    const item = basketItemFrom(found.data, { title: entry.summary.title, pageTitle: page.pageTitle, url: page.url, decimal: page.decimal }, newItemId(), Date.now());
    let result;
    try {
      result = await addBasketItem(item);
    } catch {
      showNotice('error', "Couldn't save the basket", 'Please try again.');
      return;
    }
    if (!result.ok) {
      const failure = basketFailure(result.reason, limitsFor(plan).basketTables);
      showNotice(result.reason === 'duplicate' ? 'info' : 'error', failure.title, failure.detail);
      return;
    }
    basket = result.items;
    renderBasket();
    flash(button, 'Added');
    announce(`Added ${entry.name} to the basket: ${basket.length} ${plural(basket.length, 'table')}.`);
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
      if (tabId === null) return false;
      let read: TableRead;
      try {
        read = await callPage(tabId, 0, 'readTableAt', entry.summary.index, entry.summary.signature);
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
  button.classList.add('active');
  button.setAttribute('aria-expanded', 'true');
  const picker = h('div', { class: 'column-picker mt-2', attrs: { role: 'group', 'aria-label': `Columns of ${entry.name}` } });
  entry.element.append(picker);
  renderPicker(entry, picker);
  renderPreview(entry);
  picker.querySelector<HTMLInputElement>('input')?.focus();
}

function renderPicker(entry: Entry, picker: HTMLElement, focus?: { column: number; control: 'up' | 'down' | 'check' }): void {
  const data = entry.data;
  const state = entry.columns;
  if (!data || !state) return;
  const labels = columnLabels(data);
  const selected = selectedColumns(state).length;

  const setAll = (on: boolean) => {
    state.enabled = new Set(on ? state.order : []);
    update();
  };
  const update = (next?: typeof focus) => {
    renderPicker(entry, picker, next);
    renderPreview(entry);
    announce(`${selectedColumns(state).length} of ${data.width} columns selected.`);
  };

  const rows = state.order.map((column, position) => {
    const id = `col-${entry.summary.index}-${column}`;
    const label = labels[column] ?? `Column ${column + 1}`;
    const checkbox = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', id, 'data-column': String(column) } });
    checkbox.checked = state.enabled.has(column);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.enabled.add(column);
      else state.enabled.delete(column);
      update({ column, control: 'check' });
    });
    const move = (step: -1 | 1) => {
      const button = h('button', {
        class: 'btn btn-icon btn-move',
        attrs: { type: 'button', 'data-move': step < 0 ? 'up' : 'down', 'aria-label': `Move ${label} ${step < 0 ? 'up' : 'down'}`, title: step < 0 ? 'Move up' : 'Move down' },
      });
      button.append(svgIcon(step < 0 ? upIcon : downIcon, 13));
      const disabled = step < 0 ? position === 0 : position === state.order.length - 1;
      button.disabled = disabled;
      button.addEventListener('click', () => {
        state.order = moveColumn(state.order, position, step);
        update({ column, control: step < 0 ? 'up' : 'down' });
      });
      return button;
    };
    const sample = columnSample(data, column);
    return h(
      'li',
      { class: `picker-row${state.enabled.has(column) ? '' : ' is-off'}`, attrs: { 'data-column': String(column) } },
      checkbox,
      h('label', { class: 'picker-label', attrs: { for: id } }, h('span', { class: 'picker-name', text: label }), sample ? h('span', { class: 'picker-sample', text: sample }) : null),
      move(-1),
      move(1),
    );
  });

  picker.replaceChildren(
    h(
      'div',
      { class: 'd-flex align-items-center gap-2 picker-head' },
      h('span', { class: 'section-label', text: 'Columns' }),
      h('span', { class: 'picker-count mono', text: `${selected} of ${data.width}` }),
      h('button', { class: 'btn btn-link btn-sm p-0 ms-auto', text: 'All', attrs: { type: 'button', 'data-select': 'all' }, on: { click: () => setAll(true) } }),
      h('button', { class: 'btn btn-link btn-sm p-0', text: 'None', attrs: { type: 'button', 'data-select': 'none' }, on: { click: () => setAll(false) } }),
    ),
    h('ul', { class: 'picker-list list-unstyled m-0' }, ...rows),
  );

  // Keep keyboard focus on the control that was used, now in its new place.
  if (focus) {
    const row = picker.querySelector(`li[data-column="${focus.column}"]`);
    const target =
      focus.control === 'check'
        ? row?.querySelector<HTMLElement>('input')
        : (row?.querySelector<HTMLButtonElement>(`[data-move="${focus.control}"]:not(:disabled)`) ?? row?.querySelector<HTMLElement>('button:not(:disabled)'));
    target?.focus();
  }
  const empty = selected === 0;
  for (const button of entry.element.querySelectorAll<HTMLButtonElement>('.format-buttons .btn, [data-action="xlsx"], [data-action="basket"]')) button.disabled = empty;
}

// --- Basket -----------------------------------------------------------------------------

function renderBasket(): void {
  els.basketCount.hidden = basket.length === 0;
  els.basketCount.textContent = String(basket.length);
  if (!hasFeature(plan, 'merge-tables')) {
    const link = h('button', { class: 'btn btn-link btn-sm p-0', text: 'About Pro', attrs: { type: 'button' } });
    link.addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#pro') }));
    els.basket.replaceChildren(h('div', { class: 'empty-state' }, svgIcon(basketIcon, 22), h('span', {}, `${upgradeMessage('merge-tables')} `, link)));
    return;
  }
  if (basket.length === 0) {
    els.basket.replaceChildren(emptyState(basketIcon, 'Add tables from this page or others with Basket, then export them together as one table.'));
    return;
  }

  const items = basket.map((item, index) => {
    const label = itemLabel(item, index);
    const remove = h('button', { class: 'btn btn-icon btn-remove', attrs: { type: 'button', 'aria-label': `Remove ${label}`, title: 'Remove' } }, svgIcon(removeIcon, 12));
    remove.addEventListener('click', () => void removeItem(item.id));
    const meta = [tableSize(item.rows.length + 1, item.columns.length), itemHost(item)].filter(Boolean).join(' · ');
    return h(
      'li',
      { class: 'list-group-item basket-item d-flex align-items-center gap-2', attrs: { 'data-id': item.id } },
      h('div', { class: 'min-w-0 flex-grow-1' }, h('div', { class: 'basket-title text-truncate', text: label, attrs: { title: label } }), h('div', { class: 'basket-meta text-truncate', text: meta, attrs: { title: item.url } })),
      remove,
    );
  });

  const merged = mergeBasket(basket, { source: settings.mergeSource });
  const sourceSwitch = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', role: 'switch', id: 'merge-source' } });
  sourceSwitch.checked = settings.mergeSource;
  sourceSwitch.addEventListener('change', () => void updateSettings({ mergeSource: sourceSwitch.checked }));

  const layoutRadio = (value: MergeLayout, label: string) => {
    const id = `layout-${value}`;
    const input = h('input', { class: 'btn-check', attrs: { type: 'radio', name: 'merge-layout', id, value, autocomplete: 'off' } });
    input.checked = settings.mergeLayout === value;
    input.addEventListener('change', () => {
      if (input.checked) void updateSettings({ mergeLayout: value });
    });
    return [input, h('label', { class: 'btn btn-outline-secondary', text: label, attrs: { for: id } })];
  };

  const copyButtons = TABLE_FORMATS.map((format) => {
    const button = h('button', { class: 'btn btn-outline-primary', text: FORMAT_LABELS[format], attrs: { type: 'button', 'data-format': format, title: `Copy the merged table as ${FORMAT_LABELS[format]}` } });
    button.addEventListener('click', () => void copyBasket(format, button));
    return button;
  });
  const download = h('button', { class: 'btn btn-primary btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1', attrs: { type: 'button', id: 'basket-xlsx' } }, svgIcon(spreadsheetIcon, 14), 'Download .xlsx');
  download.addEventListener('click', () => void downloadBasket(download));
  const clear = h('button', { class: 'btn btn-outline-danger btn-sm', text: 'Clear', attrs: { type: 'button', id: 'basket-clear' } });
  clear.addEventListener('click', () => void clearAll());

  els.basket.replaceChildren(
    h('ul', { class: 'list-group list-group-flush basket-list' }, ...items),
    h(
      'div',
      { class: 'card-body p-3 border-top' },
      h('div', { class: 'basket-summary small mb-2', attrs: { id: 'basket-summary' } }, 'Merged: ', h('span', { class: 'mono', text: tableSize(merged.rows.length, merged.width) })),
      h(
        'div',
        { class: 'd-flex align-items-center flex-wrap gap-2 mb-2' },
        h('div', { class: 'form-check form-switch m-0' }, sourceSwitch, h('label', { class: 'form-check-label small', text: 'Source columns', attrs: { for: 'merge-source', title: 'Add "Source" and "Source URL" columns' } })),
        h('div', { class: 'btn-group btn-group-sm ms-auto layout-group', attrs: { role: 'group', 'aria-label': '.xlsx layout' } }, ...layoutRadio('stack', 'One sheet'), ...layoutRadio('sheets', 'Sheet per table')),
      ),
      h('div', { class: 'btn-group btn-group-sm w-100 format-buttons', attrs: { role: 'group', 'aria-label': 'Copy the merged table as' } }, ...copyButtons),
      h('div', { class: 'd-flex gap-2 mt-2' }, download, clear),
    ),
  );
}

async function updateSettings(patch: Partial<Settings>): Promise<void> {
  try {
    settings = await saveSettings(patch);
  } catch {
    showNotice('error', "Couldn't save the setting", 'Please try again.');
  }
  renderBasket();
}

async function removeItem(id: string): Promise<void> {
  try {
    basket = await removeBasketItem(id);
  } catch {
    showNotice('error', "Couldn't update the basket", 'Please try again.');
    return;
  }
  renderBasket();
  announce(`Removed from the basket. ${basket.length} ${plural(basket.length, 'table')} left.`);
  els.basket.querySelector<HTMLElement>('.btn-remove, #basket-summary')?.focus();
}

async function clearAll(): Promise<void> {
  try {
    await clearBasket();
  } catch {
    showNotice('error', "Couldn't clear the basket", 'Please try again.');
    return;
  }
  basket = [];
  renderBasket();
  announce('The basket is empty.');
}

async function copyBasket(format: TableFormat, button: HTMLButtonElement): Promise<void> {
  if (!allowed('merge-tables') || basket.length === 0) return;
  const merged = mergeBasket(basket, { source: settings.mergeSource });
  await copyAndConfirm(formatTable(merged, format, settings), button, `Copied ${basket.length} merged ${plural(basket.length, 'table')} as ${FORMAT_LABELS[format]}: ${tableSize(merged.rows.length, merged.width)}.`);
}

async function downloadBasket(button: HTMLButtonElement): Promise<void> {
  if (!allowed('merge-tables') || !allowed('xlsx') || basket.length === 0) return;
  const sheets = basketSheets(basket, { source: settings.mergeSource, layout: settings.mergeLayout });
  // Each sheet carries its pages' decimal separator; a stacked sheet mixing both keeps text.
  const bytes = buildXlsx(sheets, { numbers: settings.xlsxNumbers });
  const name = fileName(basket.length === 1 ? itemLabel(basket[0] as BasketItem, 0) : 'merged tables', 'xlsx');
  downloadBytes(bytes, name, XLSX_MIME);
  flash(button, 'Saved');
  announce(`Downloaded ${name}: ${formatCount(cellCount(basket))} cells from ${basket.length} ${plural(basket.length, 'table')}.`);
}

// --- Copying ----------------------------------------------------------------------------

async function busy<T>(button: HTMLButtonElement, run: () => Promise<T>): Promise<T> {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await run();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function copyAndConfirm(payload: ClipboardPayload, button: HTMLButtonElement, message: string): Promise<void> {
  if (!payload.text.trim()) {
    showNotice('error', 'Nothing to copy', 'The table has no visible text.');
    return;
  }
  button.disabled = true;
  let copied = false;
  try {
    copied = (await copyFromPage(payload)) || (await copyInBackground(payload));
  } finally {
    button.disabled = false;
  }
  if (!copied) {
    showNotice('error', "Couldn't copy to the clipboard", 'Please try again.');
    return;
  }
  flash(button, 'Copied');
  announce(message);
}

async function copyInBackground(payload: ClipboardPayload): Promise<boolean> {
  try {
    const request: CopyRequest = { type: 'tc/copy', payload };
    const response = (await chrome.runtime.sendMessage(request)) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch {
    return false;
  }
}

const flashed = new WeakMap<HTMLButtonElement, { children: Node[]; timer: number }>();

/** Inline success state on the button that was pressed, restored after a moment. */
function flash(button: HTMLButtonElement, label: string): void {
  const current = flashed.get(button);
  const children = current?.children ?? Array.from(button.childNodes);
  window.clearTimeout(current?.timer);
  button.classList.add('is-done');
  button.replaceChildren(svgIcon(checkIcon, 14), label);
  const timer = window.setTimeout(() => {
    button.classList.remove('is-done');
    button.replaceChildren(...children);
    flashed.delete(button);
  }, 1600);
  flashed.set(button, { children, timer });
}

function emptyState(icon: string, message: string, extraClass = ''): HTMLElement {
  return h('div', { class: `empty-state ${extraClass}`.trim() }, svgIcon(icon, 22), h('span', { text: message }));
}

// --- Events -----------------------------------------------------------------------------

els.openOptions.addEventListener('click', () => void chrome.runtime.openOptionsPage());
els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// Tables added from the context menu (or another window) while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('basket' in changes)) return;
  void loadBasket().then((items) => {
    basket = items;
    renderBasket();
  });
});

init().catch((error: unknown) => {
  console.error('Table Copy: popup failed', error);
  showNotice('error', 'Table Copy failed to start', 'Close and reopen the popup.');
});
