import checkIcon from 'bootstrap-icons/icons/check2.svg';
import codeIcon from 'bootstrap-icons/icons/code-slash.svg';
import cursorIcon from 'bootstrap-icons/icons/cursor-text.svg';
import downloadIcon from 'bootstrap-icons/icons/download.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import warningIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import gearIcon from 'bootstrap-icons/icons/gear.svg';
import infoIcon from 'bootstrap-icons/icons/info-circle-fill.svg';
import keyboardIcon from 'bootstrap-icons/icons/keyboard.svg';
import linkIcon from 'bootstrap-icons/icons/link-45deg.svg';
import markdownIcon from 'bootstrap-icons/icons/markdown.svg';
import successIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import tableIcon from 'bootstrap-icons/icons/table.svg';
import textIcon from 'bootstrap-icons/icons/text-left.svg';
import {
  SELECTION_FORMAT_LABELS,
  TABLE_FORMAT_LABELS,
  TABLE_FORMATS,
  type ClipboardPayload,
  type SelectionFormat,
  type TableFormat,
} from '../core/convert';
import { downloadFile, type DownloadKind } from '../core/download';
import { cleanPageUrl, pageLinkMarkdown } from '../core/pageLink';
import { EARLY_ACCESS, proMessage, type ProFeature } from '../core/plan';
import { defaultSettings, type Settings } from '../core/settings';
import type { PageInfo, SelectionPreview } from '../page/index';
import type { TableList, TableSummary } from '../page/reader';
import type { CopyRequest } from '../platform/messages';
import { callPage, readPageInfo } from '../platform/page';
import { canUse, loadEntitlements, loadSettings, takeNotice, type Entitlements } from '../storage/store';
import { copyFromPage } from '../ui/clipboard';
import { saveFile } from '../ui/download';
import { byId, h } from '../ui/dom';
import { formatCount, plural, tableSize } from '../ui/format';
import { svgIcon } from '../ui/icons';
import { openAboutPro, proBadge } from '../ui/pro';

const COMMAND = 'copy-selection';
const PREVIEW_COLUMNS = 6;

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  notice: byId<HTMLDivElement>('notice'),
  selectionSection: byId<HTMLElement>('selection-section'),
  selection: byId<HTMLDivElement>('selection'),
  selectionCount: byId<HTMLSpanElement>('selection-count'),
  pageSection: byId<HTMLElement>('page-section'),
  pageTitle: byId<HTMLSpanElement>('page-title'),
  copyPageLink: byId<HTMLButtonElement>('copy-page-link'),
  tablesSection: byId<HTMLElement>('tables-section'),
  tables: byId<HTMLDivElement>('tables'),
  tablesCount: byId<HTMLSpanElement>('tables-count'),
  shortcutIcon: byId<HTMLSpanElement>('shortcut-icon'),
  shortcutText: byId<HTMLSpanElement>('shortcut-text'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  status: byId<HTMLDivElement>('status'),
};

let tabId: number | null = null;
let settings: Settings = defaultSettings();
let entitlements: Entitlements = { plan: 'free', earlyAccess: EARLY_ACCESS };
let page: PageInfo = { title: '', url: '' };

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

  const [notice, loaded, access, tab] = await Promise.all([takeNotice(), loadSettings(), loadEntitlements(), targetTab()]);
  settings = loaded;
  entitlements = access;
  void renderShortcut();
  if (notice) showNotice(notice.tone, notice.title, notice.detail, 'stored');
  void clearBadge(tab?.id);

  if (tab?.id === undefined) return renderUnreadable();
  tabId = tab.id;
  const [selection, tables, info] = await Promise.allSettled([
    callPage(tab.id, 0, 'previewSelection'),
    callPage(tab.id, 0, 'listTables'),
    readPageInfo(tab),
  ]);
  if (selection.status === 'rejected' && tables.status === 'rejected') return renderUnreadable();
  renderPage(info.status === 'fulfilled' ? info.value : { title: tab.title ?? '', url: tab.url ?? '' });
  renderSelection(selection.status === 'fulfilled' ? selection.value : null);
  renderTables(tables.status === 'fulfilled' ? tables.value : null);
}

function renderLoading(): void {
  const line = (width: string) => h('span', { class: `placeholder d-block mb-1 rounded w-${width}` });
  els.selection.replaceChildren(
    h('div', { class: 'card-body p-3 placeholder-glow', attrs: { 'aria-hidden': 'true' } }, line('100'), line('75'), h('span', { class: 'placeholder d-block w-100 rounded mt-3', attrs: { style: 'height: 2rem' } })),
  );
  els.tables.replaceChildren(
    ...[0, 1].map(() =>
      h('div', { class: 'list-group-item table-skeleton placeholder-glow', attrs: { 'aria-hidden': 'true' } }, line('50'), h('span', { class: 'placeholder d-block w-100 rounded mt-2', attrs: { style: 'height: 3.5rem' } })),
    ),
  );
  els.status.textContent = 'Reading the page…';
}

function renderUnreadable(): void {
  els.selectionSection.hidden = true;
  els.pageSection.hidden = true;
  els.tablesSection.hidden = true;
  els.status.textContent = "This page can't be read.";
  // A message left by the background already explains it.
  if (els.notice.querySelector('[data-key="stored"]')) return;
  showNotice(
    'warning',
    "Universal Copy can't read this page",
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
    if (shortcut) {
      els.shortcutText.replaceChildren(h('kbd', { text: shortcut }), ` copies the selection as ${SELECTION_FORMAT_LABELS[settings.shortcutFormat]}`);
    } else {
      els.shortcutText.textContent = 'No keyboard shortcut set';
    }
  } catch {
    els.shortcutText.textContent = 'Keyboard shortcut unavailable';
  }
}

// --- Notices ----------------------------------------------------------------------------

type Tone = 'success' | 'error' | 'info' | 'warning';

/**
 * Alerts at the top of the popup. Each key holds one alert, so the page state ("can't read
 * this page"), a message left by the background and the latest copy error can coexist.
 */
function showNotice(tone: Tone, title: string, detail?: string, key = 'message', dismissible = true, action?: { label: string; run: () => void }): void {
  const variant = { success: 'success', error: 'danger', info: 'primary', warning: 'warning' }[tone];
  const iconSource = { success: successIcon, error: errorIcon, info: infoIcon, warning: warningIcon }[tone];
  const alert = h(
    'div',
    {
      class: `alert alert-${variant} d-flex align-items-start gap-2 py-2 px-3 small mb-3`,
      attrs: { role: tone === 'error' ? 'alert' : 'status', 'data-key': key },
    },
    svgIcon(iconSource, 16),
    h(
      'div',
      {},
      h('div', { class: 'fw-bold', text: title }),
      detail ? h('div', { text: detail }) : null,
      action ? h('button', { class: 'btn btn-link btn-sm p-0 mt-1 notice-action', text: action.label, attrs: { type: 'button' }, on: { click: action.run } }) : null,
    ),
  );
  if (dismissible) {
    alert.append(
      h('button', {
        class: 'btn-close ms-auto',
        attrs: { type: 'button', 'aria-label': 'Dismiss' },
        on: { click: () => alert.remove() },
      }),
    );
  }
  const existing = els.notice.querySelector(`[data-key="${key}"]`);
  if (existing) existing.replaceWith(alert);
  else els.notice.append(alert);
  els.notice.hidden = false;
}

function announce(message: string): void {
  els.status.textContent = message;
}

// --- Selection --------------------------------------------------------------------------

const SELECTION_BUTTONS: { format: SelectionFormat; label: string; icon: string; title: string }[] = [
  { format: 'markdown', label: 'Markdown', icon: markdownIcon, title: 'Copy as Markdown' },
  { format: 'text', label: 'Text', icon: textIcon, title: 'Copy as clean text' },
  { format: 'html', label: 'HTML', icon: codeIcon, title: 'Copy as clean HTML (keeps structure, drops the site styling)' },
];

function renderSelection(preview: SelectionPreview | null): void {
  els.selectionCount.textContent = '';
  if (!preview) {
    els.selection.replaceChildren(emptyState(warningIcon, "Couldn't read the selection on this page."));
    return;
  }
  if (preview.kind === 'empty') {
    els.selection.replaceChildren(emptyState(cursorIcon, 'Select text on the page to copy it as Markdown, clean text or HTML.'));
    return;
  }
  if (!preview.text.trim()) {
    els.selection.replaceChildren(emptyState(cursorIcon, 'The selection has no visible text.'));
    return;
  }
  els.selectionCount.textContent = `${formatCount(preview.length)} ${plural(preview.length, 'char')}`;
  const buttons = SELECTION_BUTTONS.map(({ format, label, icon, title }) => {
    const button = h('button', { class: 'btn btn-outline-primary', attrs: { type: 'button', title, 'data-format': format } }, svgIcon(icon, 15), label);
    button.addEventListener('click', () => void copySelection(format, button));
    return button;
  });
  els.selection.replaceChildren(
    h(
      'div',
      { class: 'card-body p-3' },
      h('p', { class: 'selection-preview small mb-3', text: preview.text.slice(0, 400) }),
      preview.truncated ? h('p', { class: 'small text-warning-emphasis mb-2', text: 'Very large selection: only the first part will be copied.' }) : null,
      h('div', { class: 'btn-group w-100 format-buttons', attrs: { role: 'group', 'aria-label': 'Copy the selection as' } }, ...buttons),
      h('div', { class: 'download-row mt-2' }, downloadSelectionButton()),
    ),
  );
}

function downloadSelectionButton(): HTMLButtonElement {
  const button = h(
    'button',
    { class: 'btn btn-link btn-sm download-button', attrs: { type: 'button', 'data-download': 'md', title: 'Download the selection as a Markdown file' } },
    svgIcon(downloadIcon, 14),
    'Download .md',
    proBadge(),
  );
  button.addEventListener('click', () => void downloadSelection(button));
  return button;
}

async function downloadSelection(button: HTMLButtonElement): Promise<void> {
  if (tabId === null || !requirePro('download')) return;
  let result;
  try {
    result = await callPage(tabId, 0, 'convertSelection', 'markdown', settings);
  } catch {
    showNotice('error', "Couldn't read the selection", 'The page may have changed or navigated away. Reopen the popup and try again.');
    return;
  }
  if (result.kind === 'empty' || !result.payload.text.trim()) {
    showNotice('error', 'Nothing to download', 'The selection is gone or has no visible text. Select text on the page and reopen the popup.');
    return;
  }
  save(result.payload.text, 'md', page.title, button);
}

// --- This page (Pro: link as Markdown) ---------------------------------------------------

function renderPage(info: PageInfo): void {
  page = info;
  const url = cleanPageUrl(info.url);
  els.pageTitle.textContent = info.title.trim() || url || 'This page has no web address';
  els.pageTitle.title = url ?? '';
  els.copyPageLink.disabled = !url;
  els.copyPageLink.prepend(svgIcon(linkIcon, 15));
  els.copyPageLink.append(proBadge());
  els.pageSection.hidden = false;
}

async function copyPageLink(): Promise<void> {
  if (!requirePro('page-link')) return;
  const payload = pageLinkMarkdown(page.title, page.url);
  if (!payload) {
    showNotice('error', 'No web address to link to', 'Only http and https pages can be copied as a link.');
    return;
  }
  await copyAndConfirm(payload, els.copyPageLink, `Copied the page link as Markdown: ${payload.text}`);
}

async function copySelection(format: SelectionFormat, button: HTMLButtonElement): Promise<void> {
  if (tabId === null) return;
  let result;
  try {
    result = await callPage(tabId, 0, 'convertSelection', format, settings);
  } catch {
    showNotice('error', "Couldn't read the selection", 'The page may have changed or navigated away. Reopen the popup and try again.');
    return;
  }
  if (result.kind === 'empty' || !result.payload.text.trim()) {
    showNotice('error', 'Nothing to copy', 'The selection is gone or has no visible text. Select text on the page and reopen the popup.');
    return;
  }
  await copyAndConfirm(result.payload, button, `Copied the selection as ${SELECTION_FORMAT_LABELS[format]}.`);
}

// --- Tables -----------------------------------------------------------------------------

function renderTables(list: TableList | null): void {
  if (!list) {
    els.tables.replaceChildren(emptyState(warningIcon, "Couldn't look for tables on this page.", 'list-group-item'));
    return;
  }
  els.tablesCount.hidden = list.total === 0;
  els.tablesCount.textContent = formatCount(list.total);
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
  const buttons = TABLE_FORMATS.map((format) => {
    const button = h('button', {
      class: 'btn btn-outline-primary',
      text: format === 'tsv' ? 'TSV' : TABLE_FORMAT_LABELS[format],
      attrs: {
        type: 'button',
        'data-format': format,
        title: format === 'tsv' ? 'Copy as TSV: pastes into Excel and Google Sheets as cells' : `Copy as ${TABLE_FORMAT_LABELS[format]}`,
      },
    });
    button.addEventListener('click', () => void copyTable(summary, name, format, button));
    return button;
  });
  const more = summary.columns - PREVIEW_COLUMNS;
  return h(
    'div',
    { class: 'list-group-item table-item', attrs: { 'data-index': String(summary.index) } },
    h(
      'div',
      { class: 'd-flex align-items-baseline gap-2' },
      h('span', { class: 'table-title text-truncate', text: name, attrs: { title: name } }),
      h('span', { class: 'table-dims mono ms-auto', text: `${formatCount(summary.rows)} × ${formatCount(summary.columns)}`, attrs: { title: tableSize(summary.rows, summary.columns) } }),
    ),
    previewTable(summary),
    more > 0 ? h('div', { class: 'more-columns mt-1', text: `+${more} more ${plural(more, 'column')}` }) : null,
    h('div', { class: 'btn-group btn-group-sm w-100 mt-2 format-buttons', attrs: { role: 'group', 'aria-label': `Copy ${name} as` } }, ...buttons),
    tableDownloads(summary, name, position),
  );
}

const TABLE_DOWNLOADS: readonly { kind: DownloadKind; format: TableFormat }[] = [
  { kind: 'csv', format: 'csv' },
  { kind: 'json', format: 'json' },
];

function tableDownloads(summary: TableSummary, name: string, position: number): HTMLElement {
  // Tables without a caption are named after the page: "Page title - table 2.csv".
  const fileName = summary.title || `${page.title || 'table'} - table ${position}`;
  const buttons = TABLE_DOWNLOADS.map(({ kind, format }) => {
    const button = h(
      'button',
      { class: 'btn btn-link btn-sm download-button', attrs: { type: 'button', 'data-download': kind, title: `Download ${name} as a .${kind} file` } },
      `.${kind}`,
    );
    button.addEventListener('click', () => void downloadTable(summary, format, kind, fileName, button));
    return button;
  });
  return h(
    'div',
    { class: 'download-row mt-1', attrs: { role: 'group', 'aria-label': `Download ${name}` } },
    h('span', { class: 'download-label' }, svgIcon(downloadIcon, 14), 'Download'),
    ...buttons,
    proBadge(),
  );
}

async function downloadTable(summary: TableSummary, format: TableFormat, kind: DownloadKind, fileName: string, button: HTMLButtonElement): Promise<void> {
  if (tabId === null || !requirePro('download')) return;
  let result;
  try {
    result = await callPage(tabId, 0, 'convertTableAt', summary.index, summary.signature, format, settings);
  } catch {
    showNotice('error', "Couldn't read the table", 'The page may have changed or navigated away. Reopen the popup and try again.');
    return;
  }
  if (result.status !== 'ok') {
    showNotice('error', 'This table has changed', 'The page updated since the popup opened. Reopen the popup to download the current table.');
    return;
  }
  if (!result.payload.text.trim()) {
    showNotice('error', 'This table is empty', 'It has no visible text to download.');
    return;
  }
  save(result.payload.text, kind, fileName, button);
}

// --- Pro ----------------------------------------------------------------------------------

/** True when the feature is available; otherwise a calm note with a link to About Pro. */
function requirePro(feature: ProFeature): boolean {
  if (canUse(entitlements, feature)) return true;
  showNotice('info', 'Pro feature', proMessage(feature), 'pro', true, { label: 'About Pro', run: openAboutPro });
  return false;
}

function previewTable(summary: TableSummary): HTMLElement | null {
  if (summary.preview.length === 0) return null;
  const rows = summary.preview.map((row, index) => {
    const header = index < summary.headerRows;
    return h('tr', { class: header ? 'header-row' : '' }, ...row.map((value) => h(header ? 'th' : 'td', { text: value, attrs: { title: value } })));
  });
  return h('div', { class: 'table-preview', attrs: { 'aria-hidden': 'true' } }, h('table', { class: 'table table-sm' }, h('tbody', {}, ...rows)));
}

async function copyTable(summary: TableSummary, name: string, format: TableFormat, button: HTMLButtonElement): Promise<void> {
  if (tabId === null) return;
  let result;
  try {
    result = await callPage(tabId, 0, 'convertTableAt', summary.index, summary.signature, format, settings);
  } catch {
    showNotice('error', "Couldn't read the table", 'The page may have changed or navigated away. Reopen the popup and try again.');
    return;
  }
  if (result.status !== 'ok') {
    showNotice('error', 'This table has changed', 'The page updated since the popup opened. Reopen the popup to copy the current table.');
    return;
  }
  if (!result.payload.text.trim()) {
    showNotice('error', 'This table is empty', 'It has no visible text to copy.');
    return;
  }
  await copyAndConfirm(result.payload, button, `Copied ${name} as ${TABLE_FORMAT_LABELS[format]}: ${tableSize(result.rows, result.columns)}.`);
}

// --- Copying and saving -------------------------------------------------------------------

function save(content: string, kind: DownloadKind, baseName: string, button: HTMLButtonElement): void {
  const file = downloadFile(content, kind, baseName);
  try {
    saveFile(file);
  } catch {
    showNotice('error', "Couldn't save the file", 'Please try again.');
    return;
  }
  flashDone(button, 'Saved');
  announce(`Downloaded ${file.filename}.`);
}

async function copyAndConfirm(payload: ClipboardPayload, button: HTMLButtonElement, message: string): Promise<void> {
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
  flashDone(button, 'Copied');
  announce(message);
}

async function copyInBackground(payload: ClipboardPayload): Promise<boolean> {
  try {
    const request: CopyRequest = { type: 'uc/copy', payload };
    const response = (await chrome.runtime.sendMessage(request)) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch {
    return false;
  }
}

const copiedButtons = new WeakMap<HTMLButtonElement, { children: Node[]; timer: number }>();

/** Inline success state on the button that was pressed, restored after a moment. */
function flashDone(button: HTMLButtonElement, label: string): void {
  const current = copiedButtons.get(button);
  const children = current?.children ?? Array.from(button.childNodes);
  window.clearTimeout(current?.timer);
  button.classList.add('is-copied');
  button.replaceChildren(svgIcon(checkIcon, 15), label);
  const timer = window.setTimeout(() => {
    button.classList.remove('is-copied');
    button.replaceChildren(...children);
    copiedButtons.delete(button);
  }, 1600);
  copiedButtons.set(button, { children, timer });
}

function emptyState(icon: string, message: string, extraClass = ''): HTMLElement {
  return h('div', { class: `empty-state ${extraClass}`.trim() }, svgIcon(icon, 22), h('span', { text: message }));
}

// --- Events -----------------------------------------------------------------------------

els.openOptions.addEventListener('click', () => void chrome.runtime.openOptionsPage());
els.copyPageLink.addEventListener('click', () => void copyPageLink());
els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

init().catch((error: unknown) => {
  console.error('Universal Copy: popup failed', error);
  showNotice('error', 'Universal Copy failed to start', 'Close and reopen the popup.');
});
