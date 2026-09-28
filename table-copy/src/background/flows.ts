import { basketItemFrom } from '../core/basket';
import { FORMAT_LABELS, formatTable, type TableFormat } from '../core/formats';
import { hasFeature, limitsFor } from '../core/plan';
import type { TableRead } from '../page/index';
import type { ToastMessage } from '../page/toast';
import { callPage } from '../platform/page';
import { addBasketItem, loadPlan, loadSettings, newItemId, setNotice } from '../storage/store';
import { basketFailure, plural, tableSize } from '../ui/format';
import { copyToClipboard } from './clipboard';

export type TabWithId = chrome.tabs.Tab & { id: number };

export const UNREADABLE_PAGE =
  "Chrome doesn't let extensions read this page (for example chrome:// pages, the Chrome Web Store or the PDF viewer).";

type ReadOk = Extract<TableRead, { status: 'ok' }>;

/** The table around the selection, or the toast that explains why there isn't one. */
async function readSelected(tab: TabWithId, frameId: number): Promise<ReadOk | ToastMessage> {
  let result: TableRead;
  try {
    result = await callPage(tab.id, frameId, 'readSelectedTable');
  } catch {
    return { tone: 'error', title: "Can't read tables on this page", detail: UNREADABLE_PAGE };
  }
  if (result.status === 'ok') {
    if (result.data.rows.length === 0) return { tone: 'error', title: 'This table is empty', detail: 'It has no visible text to copy.' };
    return result;
  }
  if (result.status === 'no-table') {
    return {
      tone: 'error',
      title: 'No table in the selection',
      detail: 'Select text inside a table, or click the Table Copy toolbar button to pick a table on this page.',
    };
  }
  return { tone: 'error', title: 'Nothing is selected', detail: 'Select some text inside a table first.' };
}

/** "Copy table as": the table around (or overlapping) the selection. */
export async function copySelectedTable(tab: TabWithId, frameId: number, format: TableFormat): Promise<ToastMessage> {
  const [read, settings] = await Promise.all([readSelected(tab, frameId), loadSettings()]);
  if (!('status' in read)) return notify(tab.id, read);
  const payload = formatTable(read.data, format, settings);
  if (!(await copyToClipboard(payload))) {
    return notify(tab.id, { tone: 'error', title: "Couldn't copy to the clipboard", detail: 'Please try again.' });
  }
  const parts = [tableSize(read.data.rows.length, read.data.width)];
  if (read.overlapping > 1) parts.push(`the first of ${read.overlapping} tables in the selection`);
  if (read.data.truncated) parts.push('very large table: only the first part was copied');
  return notify(tab.id, {
    tone: read.overlapping > 1 || read.data.truncated ? 'info' : 'success',
    title: `Copied table as ${FORMAT_LABELS[format]}`,
    detail: parts.join(' · '),
  });
}

/** "Add table to basket" (Pro: merge tables). */
export async function addSelectedToBasket(tab: TabWithId, frameId: number): Promise<ToastMessage> {
  const plan = await loadPlan();
  const limits = limitsFor(plan);
  if (!hasFeature(plan, 'merge-tables')) return notify(tab.id, { tone: 'info', ...basketFailure('not-allowed', limits.basketTables) });
  const read = await readSelected(tab, frameId);
  if (!('status' in read)) return notify(tab.id, read);
  const item = basketItemFrom(
    read.data,
    { title: read.title, pageTitle: read.page.pageTitle || tab.title || '', url: read.page.url || tab.url || '', decimal: read.page.decimal },
    newItemId(),
    Date.now(),
  );
  let result;
  try {
    result = await addBasketItem(item);
  } catch {
    return notify(tab.id, { tone: 'error', title: "Couldn't save the basket", detail: 'Please try again.' });
  }
  if (!result.ok) return notify(tab.id, { tone: 'error', ...basketFailure(result.reason, limits.basketTables) });
  const count = result.items.length;
  return notify(tab.id, {
    tone: 'success',
    title: 'Added to the basket',
    detail: `${tableSize(item.rows.length + 1, item.columns.length)} · ${count} ${plural(count, 'table')} in the basket. Export it from the toolbar button.`,
  });
}

/**
 * Shows the result as a toast in the page. Pages that can't be scripted get a badge on
 * the toolbar icon instead, and the popup shows the message when it's opened next.
 */
export async function notify(tabId: number, message: ToastMessage): Promise<ToastMessage> {
  try {
    await callPage(tabId, 0, 'toast', message);
    return message;
  } catch {
    // Unscriptable page: fall back to the badge.
  }
  try {
    await setNotice(message);
    const error = message.tone === 'error';
    await chrome.action.setBadgeBackgroundColor({ tabId, color: error ? '#dc3545' : '#2b8a3e' });
    await chrome.action.setBadgeText({ tabId, text: error ? '!' : '✓' });
    await chrome.action.setTitle({ tabId, title: `Table Copy: ${message.title}` });
    if (!error) {
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
        chrome.action.setTitle({ tabId, title: 'Table Copy' }).catch(() => undefined);
      }, 4000);
    }
  } catch (error) {
    console.error('Table Copy: could not show the result', message, error);
  }
  return message;
}
