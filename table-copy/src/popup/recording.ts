import basketIcon from 'bootstrap-icons/icons/basket.svg';
import checkIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import warningIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import stopIcon from 'bootstrap-icons/icons/stop-fill.svg';
import { basketItemFrom } from '../core/basket';
import { expandLinks, withoutLinks } from '../core/links';
import { hasFeature, limitsFor } from '../core/plan';
import type { StoredRecording } from '../core/recording';
import type { TableSummary } from '../page/reader';
import { callRecorder, peekRecorder } from '../platform/page';
import type { RecordOptions } from '../recorder/index';
import { addBasketItem, clearRecording, isRecordingChange, loadRecording, newItemId, saveRecording } from '../storage/store';
import { byId, h } from '../ui/dom';
import { basketFailure, formatCount, plural, tableSize } from '../ui/format';
import { svgIcon } from '../ui/icons';
import { allowed, announce, busy, dismissNotice, flash, iconButton, isLocked, showNotice, state } from './context';
import { exportControl } from './export';
import { suspendHighlight } from './highlight';
import { renderBasket } from './basket';

/**
 * "Record rows" in the popup: starts a recording on a table (the bar in the page takes
 * over from there), and shows the last recording: live with a Stop button, or finished
 * with its exports. A recording whose page navigated away ends there, rows kept.
 */

const els = {
  section: byId<HTMLElement>('recording-section'),
  body: byId<HTMLDivElement>('recording'),
};

let current: StoredRecording | null = null;
/** The recorder in the page is still running this recording. */
let live = false;

export async function initRecording(): Promise<void> {
  current = await loadRecording();
  if (current?.state === 'recording') {
    live = await isLive(current);
    if (!live) {
      // The page navigated away or was closed: the recorder ended with it.
      current = { ...current, state: 'stopped', ended: 'navigated' };
      await saveRecording(current).catch(() => undefined);
    }
  }
  render();
}

async function isLive(recording: StoredRecording): Promise<boolean> {
  try {
    const status = await peekRecorder(recording.tabId, 'status');
    return status?.id === recording.id && status.state === 'recording';
  } catch {
    return false;
  }
}

// The recorder writes its progress while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !isRecordingChange(changes)) return;
  void loadRecording().then((recording) => {
    current = recording;
    live = recording?.state === 'recording';
    render();
  });
});

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function render(): void {
  const recording = current;
  els.section.hidden = recording === null;
  if (!recording) {
    els.body.replaceChildren();
    return;
  }
  const host = hostOf(recording.url);
  const name = recording.title || recording.pageTitle || 'Recorded rows';
  const count = `${formatCount(recording.rowCount)} ${plural(recording.rowCount, 'row')}`;

  if (live) {
    const stop = h('button', { class: 'btn btn-primary btn-sm d-inline-flex align-items-center gap-1', attrs: { type: 'button', id: 'recording-stop' } }, svgIcon(stopIcon, 14), 'Stop');
    stop.addEventListener('click', () => void stopRecording(recording, stop));
    els.body.replaceChildren(
      h(
        'div',
        { class: 'card-body p-3 recording-card is-live' },
        h('div', { class: 'd-flex align-items-center gap-2' }, h('span', { class: 'rec-dot', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'recording-title text-truncate', text: name }), h('span', { class: 'recording-count mono ms-auto', text: count })),
        h('div', { class: 'recording-meta', text: `Recording${host ? ` on ${host}` : ''}. Scroll the table or click its Next button; rows are added as they appear.` }),
        h('div', { class: 'd-flex gap-2 mt-2' }, stop),
      ),
    );
    return;
  }

  const table = recording.table;
  const width = table.width;
  const detail =
    recording.ended === 'navigated'
      ? `The page navigated away, so the recording ended. The ${count} recorded before are kept.`
      : recording.ended === 'table-gone'
        ? `The table left the page, so the recording stopped. The ${count} recorded before are kept.`
        : `Recorded${host ? ` on ${host}` : ''}.`;
  const partial = recording.partial ? ` Only the first ${formatCount(Math.max(0, table.rows.length - table.headerRows))} rows fit here; the bar on the page had them all.` : '';
  const control = exportControl(name, async () => {
    if (!current) return null;
    return { name, file: name, data: current.table, decimal: current.decimal };
  });
  const basket = iconButton('basket', basketIcon, `Add ${name} to the basket`, 'Add to basket · Pro', isLocked('merge-tables'));
  basket.addEventListener('click', () => void addToBasket(recording, name, basket));
  const discard = h('button', { class: 'btn btn-outline-secondary btn-sm', text: 'Discard', attrs: { type: 'button', id: 'recording-discard' } });
  discard.addEventListener('click', () => void discardRecording());
  const ended = recording.ended !== undefined;
  const icon = svgIcon(ended ? warningIcon : checkIcon, 15);
  icon.classList.add(ended ? 'text-warning-emphasis' : 'text-success');
  els.body.replaceChildren(
    h(
      'div',
      { class: 'card-body p-3 recording-card' },
      h('div', { class: 'd-flex align-items-center gap-2' }, icon, h('span', { class: 'recording-title text-truncate', text: name, attrs: { title: name } }), h('span', { class: 'recording-count mono ms-auto', text: tableSize(recording.rowCount, width) })),
      h('div', { class: 'recording-meta', text: `${detail}${partial}` }),
      h('div', { class: 'd-flex gap-2 mt-2 recording-actions' }, control.element, basket, discard),
    ),
  );
}

/** Starts recording a listed table; the popup then gets out of the way so the user can scroll. */
export async function startRecording(summary: TableSummary, name: string, button: HTMLButtonElement, replace = false): Promise<void> {
  if (!allowed('record-rows') || state.tabId === null) return;
  const tabId = state.tabId;
  const existing = current ?? (await loadRecording());
  if (existing && !replace && (existing.rowCount > 0 || existing.state === 'recording')) {
    const confirm = h('button', { class: 'btn btn-sm btn-primary mt-2', text: 'Replace it', attrs: { type: 'button', id: 'recording-replace' } });
    confirm.addEventListener('click', () => {
      dismissNotice('replace');
      void startRecording(summary, name, button, true);
    });
    const what = `${existing.title || 'a table'} (${formatCount(existing.rowCount)} ${plural(existing.rowCount, 'row')})`;
    showNotice('warning', 'Replace the last recording?', `Table Copy keeps one recording: ${what}. Export it first if you still need it.`, 'replace', true, confirm);
    return;
  }
  // Only one recorder writes the recording at a time.
  if (existing?.state === 'recording' && existing.tabId !== tabId) await peekRecorder(existing.tabId, 'stop').catch(() => null);

  const options: RecordOptions = {
    tabId,
    title: name,
    csvDelimiter: state.settings.csvDelimiter,
    keepLinks: state.settings.keepLinks,
    xlsxNumbers: state.settings.xlsxNumbers,
    xlsx: hasFeature(state.plan, 'xlsx'),
    basket: hasFeature(state.plan, 'merge-tables'),
  };
  suspendHighlight();
  await busy(button, async () => {
    let result;
    try {
      result = await callRecorder(tabId, 0, 'start', summary.index, summary.signature, options);
    } catch {
      showNotice('error', "Couldn't start recording", 'The page may have changed or navigated away. Reopen the popup and try again.');
      return;
    }
    if (result.status !== 'ok') {
      showNotice('error', 'This table has changed', 'The page updated since the popup opened. Reopen the popup to record the current table.');
      return;
    }
    live = true;
    current = await loadRecording();
    render();
    announce(`Recording rows of ${name}: ${formatCount(result.rows)} so far. Scroll the table or click its Next button.`);
    // The user scrolls the page now: close the toolbar popup (not the e2e test's popup tab).
    if (chrome.extension.getViews({ type: 'popup' }).includes(window)) window.close();
  });
}

async function stopRecording(recording: StoredRecording, button: HTMLButtonElement): Promise<void> {
  await busy(button, async () => {
    const status = await peekRecorder(recording.tabId, 'stop').catch(() => null);
    live = false;
    current = (await loadRecording()) ?? recording;
    if (!status) current = { ...current, state: 'stopped', ended: current.ended ?? 'navigated' };
    else if (current.state === 'recording') current = { ...current, state: 'stopped', rowCount: status.rows };
    render();
    announce(`Stopped recording: ${formatCount(current.rowCount)} ${plural(current.rowCount, 'row')}.`);
  });
}

async function addToBasket(recording: StoredRecording, name: string, button: HTMLButtonElement): Promise<void> {
  if (!allowed('merge-tables')) return;
  const data = state.settings.keepLinks ? expandLinks(recording.table) : withoutLinks(recording.table);
  const item = basketItemFrom(data, { title: name, pageTitle: recording.pageTitle, url: recording.url, decimal: recording.decimal }, newItemId(), Date.now());
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
  flash(button, `Added ${name} to the basket`, true);
  announce(`Added ${name} to the basket: ${state.basket.length} ${plural(state.basket.length, 'table')}.`);
}

async function discardRecording(): Promise<void> {
  try {
    await clearRecording();
  } catch {
    showNotice('error', "Couldn't discard the recording", 'Please try again.');
    return;
  }
  current = null;
  live = false;
  render();
  announce('Recording discarded.');
}
