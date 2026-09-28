import gearIcon from 'bootstrap-icons/icons/gear.svg';
import keyboardIcon from 'bootstrap-icons/icons/keyboard.svg';
import { EXPORT_FORMATS, FORMAT_LABELS, FORMAT_SHORT_LABELS, isExportFormat } from '../core/formats';
import type { TableList } from '../page/reader';
import { callPage } from '../platform/page';
import { loadBasket, loadPlan, loadSettings, takeNotice } from '../storage/store';
import { byId, h } from '../ui/dom';
import { svgIcon } from '../ui/icons';
import { renderBasket } from './basket';
import { announce, isLocked, lockMark, onSettingsChange, showNotice, state, updateSettings, allowed } from './context';
import { initRecording } from './recording';
import { hideTables, renderLoading, renderTables } from './tables';

const COMMAND = '_execute_action';

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  formatSwitch: byId<HTMLDivElement>('format-switch'),
  shortcutIcon: byId<HTMLSpanElement>('shortcut-icon'),
  shortcutText: byId<HTMLSpanElement>('shortcut-text'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  notice: byId<HTMLDivElement>('notice'),
};

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
  state.settings = loaded;
  state.plan = loadedPlan;
  state.basket = loadedBasket;
  renderFormatSwitch();
  void renderShortcut();
  renderBasket();
  if (notice) showNotice(notice.tone, notice.title, notice.detail, 'stored');
  void clearBadge(tab?.id);
  void initRecording();

  if (tab?.id === undefined) return renderUnreadable();
  state.tabId = tab.id;
  let list: TableList;
  try {
    list = await callPage(tab.id, 0, 'listTables');
  } catch {
    return renderUnreadable();
  }
  renderTables(list);
}

function renderUnreadable(): void {
  hideTables();
  announce("This page can't be read.");
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

// --- Format switch ----------------------------------------------------------------------

/** One format for every Copy and Download button in the popup, remembered in the settings. */
function renderFormatSwitch(): void {
  const current = state.settings.format;
  const parts = EXPORT_FORMATS.flatMap((format) => {
    const id = `format-${format}`;
    const input = h('input', { class: 'btn-check', attrs: { type: 'radio', name: 'format', id, value: format, autocomplete: 'off' } });
    input.checked = format === current;
    input.addEventListener('change', () => {
      if (!input.checked || !isExportFormat(input.value)) return;
      // .xlsx is Pro: a free user gets the calm explanation and keeps the previous format.
      if (input.value === 'xlsx' && !allowed('xlsx')) {
        renderFormatSwitch();
        return;
      }
      void updateSettings({ format: input.value });
      announce(`Format: ${FORMAT_LABELS[input.value]}.`);
    });
    const tip = format === 'tsv' ? 'TSV: pastes into Excel and Google Sheets as cells' : format === 'xlsx' ? 'Excel file · Pro' : FORMAT_LABELS[format];
    const label = h('label', { class: 'btn', text: FORMAT_SHORT_LABELS[format], attrs: { for: id, title: tip } });
    if (format === 'xlsx' && isLocked('xlsx')) label.append(lockMark());
    return [input, label];
  });
  els.formatSwitch.replaceChildren(...parts);
}

onSettingsChange(() => {
  const input = els.formatSwitch.querySelector<HTMLInputElement>(`input[value="${state.settings.format}"]`);
  if (input && !input.checked) input.checked = true;
});

// --- Events -----------------------------------------------------------------------------

els.openOptions.addEventListener('click', () => void chrome.runtime.openOptionsPage());
els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// Tables added from the context menu, the recording bar or another window while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('basket' in changes)) return;
  void loadBasket().then((items) => {
    state.basket = items;
    renderBasket();
  });
});

init().catch((error: unknown) => {
  console.error('Table Copy: popup failed', error);
  showNotice('error', 'Table Copy failed to start', 'Close and reopen the popup.');
});
