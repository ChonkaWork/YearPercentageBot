import checkIcon from 'bootstrap-icons/icons/check2.svg';
import copyIcon from 'bootstrap-icons/icons/clipboard.svg';
import downloadIcon from 'bootstrap-icons/icons/download.svg';
import spreadsheetIcon from 'bootstrap-icons/icons/file-earmark-spreadsheet.svg';
import linkIcon from 'bootstrap-icons/icons/link-45deg.svg';
import sheetsIcon from 'bootstrap-icons/icons/box-arrow-up-right.svg';
import type { DecimalSeparator } from '../core/cellValue';
import { FILE_TYPES, fileName, fileText, FORMAT_LABELS, formatTable, type ClipboardPayload, type ExportFormat, type TableFormat } from '../core/formats';
import { expandLinks, withoutLinks } from '../core/links';
import type { TableData } from '../core/table';
import { buildXlsx, type XlsxSheet } from '../core/xlsx';
import type { CopyRequest } from '../platform/messages';
import { copyFromPage } from '../ui/clipboard';
import { h } from '../ui/dom';
import { downloadBytes } from '../ui/download';
import { tableSize } from '../ui/format';
import { svgIcon } from '../ui/icons';
import { allowed, announce, flash, isLocked, lockMark, onSettingsChange, pasteShortcut, showNotice, state, updateSettings } from './context';

/**
 * Exporting a table from the popup, the same way for a listed table, the basket and a
 * recording: one split button whose main action follows the format switch in the header
 * ("Copy CSV", or "Download .xlsx"), and a menu with Download file, Open in Google Sheets
 * and Keep links.
 */

/** Google's shortcut for a new, empty spreadsheet. */
export const SHEETS_URL = 'https://sheets.new';

export interface ExportJob {
  /** What messages call it: "Pricing", "2 merged tables". */
  name: string;
  /** Base of the download's file name. */
  file: string;
  data: TableData;
  decimal: DecimalSeparator;
  /** .xlsx worksheets to write instead of one sheet from `data` (the basket's layouts). */
  sheets?: XlsxSheet[];
  /** Added to messages: " (picked columns)". */
  note?: string;
}

export interface ExportControl {
  element: HTMLElement;
  main: HTMLButtonElement;
  setDisabled(disabled: boolean): void;
}

type Loader = () => Promise<ExportJob | null>;

const controls = new Set<{ element: HTMLElement; refresh: () => void }>();

onSettingsChange(() => {
  for (const control of controls) {
    if (control.element.isConnected) control.refresh();
    else controls.delete(control);
  }
});

let openMenu: { close: (focusToggle: boolean) => void } | null = null;

document.addEventListener('pointerdown', (event) => {
  if (openMenu && !(event.target instanceof Node && (event.target as Element).closest?.('.export-control.is-open'))) openMenu.close(false);
});

/** The split button. `load` reads the data when an action runs (fresh from the page). */
export function exportControl(label: string, load: Loader): ExportControl {
  const main = h('button', { class: 'btn btn-primary btn-sm export-main', attrs: { type: 'button', 'data-action': 'copy' } });
  const toggle = h('button', {
    class: 'btn btn-primary btn-sm dropdown-toggle dropdown-toggle-split export-toggle',
    attrs: { type: 'button', 'data-action': 'menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `More ways to export ${label}` },
  });
  const menu = h('div', { class: 'dropdown-menu dropdown-menu-end export-menu', attrs: { role: 'menu', 'data-bs-popper': 'static', 'aria-label': `Export ${label}` } });
  const element = h('div', { class: 'btn-group export-control' }, main, toggle, menu);

  const refresh = () => {
    const format = state.settings.format;
    if (format === 'xlsx') {
      main.replaceChildren(svgIcon(spreadsheetIcon, 14), h('span', { text: 'Download .xlsx' }));
      if (isLocked('xlsx')) main.append(lockMark());
    } else {
      main.replaceChildren(svgIcon(copyIcon, 14), h('span', { text: `Copy ${FORMAT_LABELS[format]}` }));
    }
    main.setAttribute('aria-label', `${format === 'xlsx' ? 'Download' : 'Copy'} ${label} as ${FORMAT_LABELS[format]}`);
    main.dataset.format = format;
  };
  refresh();
  controls.add({ element, refresh });

  main.addEventListener('click', () => {
    const format = state.settings.format;
    if (format === 'xlsx') void download(load, 'xlsx', main);
    else void copy(load, format, main);
  });

  const items = (): HTMLButtonElement[] => {
    const format = state.settings.format;
    const list: HTMLButtonElement[] = [];
    const item = (action: string, icon: string, text: string, run: () => void, role = 'menuitem') => {
      const button = h('button', { class: 'dropdown-item', attrs: { type: 'button', role, 'data-action': action, tabindex: '-1' } }, svgIcon(icon, 14), h('span', { text }));
      button.addEventListener('click', () => {
        close(true);
        run();
      });
      list.push(button);
      return button;
    };
    if (format !== 'xlsx') item('download', downloadIcon, `Download .${FILE_TYPES[format].extension} file`, () => void download(load, format, main));
    item('sheets', sheetsIcon, 'Open in Google Sheets', () => void openInSheets(load, main));
    const links = item('links', state.settings.keepLinks ? checkIcon : linkIcon, 'Keep links', () => void updateSettings({ keepLinks: !state.settings.keepLinks }), 'menuitemcheckbox');
    links.setAttribute('aria-checked', String(state.settings.keepLinks));
    links.classList.toggle('is-checked', state.settings.keepLinks);
    links.title = 'Cells that are a link get a "<Column> URL" column; Markdown keeps [text](url)';
    return list;
  };

  const close = (focusToggle: boolean) => {
    menu.classList.remove('show', 'drop-up');
    element.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    if (openMenu?.close === close) openMenu = null;
    if (focusToggle) toggle.focus();
  };

  const open = () => {
    openMenu?.close(false);
    const list = items();
    menu.replaceChildren(...list.slice(0, -1), h('hr', { class: 'dropdown-divider', attrs: { role: 'separator' } }), ...list.slice(-1));
    menu.classList.add('show');
    element.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    // Open upwards when there's no room below (the last card in a short popup).
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8 && element.getBoundingClientRect().top - rect.height > 8) menu.classList.add('drop-up');
    openMenu = { close };
    list[0]?.focus();
  };

  toggle.addEventListener('click', () => (menu.classList.contains('show') ? close(false) : open()));
  toggle.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const list = Array.from(menu.querySelectorAll<HTMLButtonElement>('.dropdown-item'));
    const position = list.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (index: number) => list[(index + list.length) % list.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAt(position + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(position - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusAt(list.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      default:
        break;
    }
  });

  return {
    element,
    main,
    setDisabled(disabled) {
      main.disabled = disabled;
      toggle.disabled = disabled;
      if (disabled) close(false);
    },
  };
}

// --- Actions --------------------------------------------------------------------------------

function linked(data: TableData): TableData {
  return state.settings.keepLinks ? expandLinks(data) : withoutLinks(data);
}

/** "Pricing as CSV (picked columns): 4 rows × 4 columns". */
function describe(job: ExportJob, format: ExportFormat): string {
  return `${job.name} as ${FORMAT_LABELS[format]}${job.note ?? ''}: ${tableSize(job.data.rows.length, job.data.width)}`;
}

async function copy(load: Loader, format: TableFormat, button: HTMLButtonElement): Promise<void> {
  const job = await withBusy(button, load);
  if (!job) return;
  const payload = formatTable(job.data, format, state.settings);
  if (await copyAndConfirm(payload, button)) announce(`Copied ${describe(job, format)}.`);
}

async function download(load: Loader, format: ExportFormat, button: HTMLButtonElement): Promise<void> {
  if (format === 'xlsx' && !allowed('xlsx')) return;
  const job = await withBusy(button, load);
  if (!job) return;
  const type = FILE_TYPES[format];
  const name = fileName(job.file, type.extension);
  if (format === 'xlsx') {
    const data = linked(job.data);
    const sheets = job.sheets ?? [{ name: job.file || 'Table', rows: data.rows, headerRows: data.headerRows }];
    downloadBytes(buildXlsx(sheets, { numbers: state.settings.xlsxNumbers, decimal: job.decimal }), name, type.mime);
  } else {
    const text = fileText(job.data, format, state.settings);
    if (!text) {
      showNotice('error', 'Nothing to download', 'The table has no visible text.');
      return;
    }
    downloadBytes(new TextEncoder().encode(text), name, type.mime);
  }
  flash(button, 'Saved');
  announce(`Downloaded ${name}: ${tableSize(job.data.rows.length, job.data.width)}.`);
}

/** Copies the table as TSV (cells, not text) and opens a new Google Sheet to paste it into. */
async function openInSheets(load: Loader, button: HTMLButtonElement): Promise<void> {
  const job = await withBusy(button, load);
  if (!job) return;
  const payload = formatTable(job.data, 'tsv', state.settings);
  if (!(await copyAndConfirm(payload, button))) return;
  const message = `Copied ${describe(job, 'tsv')}. Paste with ${pasteShortcut()} in the new sheet.`;
  showNotice('success', `Paste with ${pasteShortcut()}`, 'The table is on the clipboard. Google Sheets opens in a new tab: click cell A1 and paste.', 'sheets');
  announce(message);
  // A moment to read the hint: the popup closes as soon as the new tab opens.
  window.setTimeout(() => void chrome.tabs.create({ url: SHEETS_URL }), 900);
}

async function withBusy(button: HTMLButtonElement, load: Loader): Promise<ExportJob | null> {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await load();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function copyAndConfirm(payload: ClipboardPayload, button: HTMLButtonElement): Promise<boolean> {
  if (!payload.text.trim()) {
    showNotice('error', 'Nothing to copy', 'The table has no visible text.');
    return false;
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
    return false;
  }
  flash(button, 'Copied');
  return true;
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
