import {
  convertPlainText,
  SELECTION_FORMAT_LABELS,
  TABLE_FORMAT_LABELS,
  type ClipboardPayload,
  type SelectionFormat,
  type TableFormat,
} from '../core/convert';
import type { Settings } from '../core/settings';
import type { SelectionResult } from '../page/index';
import type { ToastMessage } from '../page/toast';
import { callPage, convertSelectionInAnyFrame } from '../platform/page';
import { loadSettings, setNotice } from '../storage/store';
import { formatCount, plural, tableSize } from '../ui/format';
import { copyToClipboard } from './clipboard';

export type TabWithId = chrome.tabs.Tab & { id: number };

/** Where a request came from: a context-menu click (frame + Chrome's selection text) or the shortcut. */
export interface SelectionSource {
  frameId: number;
  /** Chrome's own copy of the selection (line breaks collapsed): the fallback for unscriptable pages. */
  selectionText?: string;
  /** The shortcut doesn't know the frame: look in all of them. */
  anyFrame?: boolean;
}

export const UNREADABLE_PAGE =
  "Chrome doesn't let extensions read this page (for example chrome:// pages, the Chrome Web Store or the PDF viewer).";

async function convertSelectionIn(tabId: number, source: SelectionSource, format: SelectionFormat, settings: Settings): Promise<SelectionResult | null> {
  if (source.anyFrame) return convertSelectionInAnyFrame(tabId, format, settings);
  try {
    return await callPage(tabId, source.frameId, 'convertSelection', format, settings);
  } catch {
    return null;
  }
}

/** Copy the selection as clean text, Markdown or clean HTML, then confirm in the page. */
export async function copySelection(tab: TabWithId, source: SelectionSource, format: SelectionFormat): Promise<ToastMessage> {
  const settings = await loadSettings();
  const converted = await convertSelectionIn(tab.id, source, format, settings);
  let payload: ClipboardPayload;
  let note: string | null = null;

  if (converted && converted.kind !== 'empty') {
    payload = converted.payload;
    if (converted.truncated) note = 'The selection is very large: only the first part was copied.';
  } else if (source.selectionText?.trim()) {
    payload = convertPlainText(source.selectionText, format);
    note = converted ? "Formatting couldn't be read here, so it was copied as plain text." : `Copied as plain text. ${UNREADABLE_PAGE}`;
  } else {
    return notify(tab.id, { tone: 'error', title: 'Nothing is selected', detail: 'Select some text on the page first.' });
  }

  if (!payload.text.trim()) {
    return notify(tab.id, {
      tone: 'error',
      title: 'Nothing to copy',
      detail: 'The selection has no visible text (only images, buttons or hidden content).',
    });
  }
  if (!(await copyToClipboard(payload))) {
    return notify(tab.id, { tone: 'error', title: "Couldn't copy to the clipboard", detail: 'Please try again.' });
  }
  return notify(tab.id, {
    tone: note ? 'info' : 'success',
    title: `Copied as ${SELECTION_FORMAT_LABELS[format]}`,
    detail: note ?? `${formatCount(payload.text.length)} ${plural(payload.text.length, 'character')}`,
  });
}

/** "Copy table as": the table around (or overlapping) the selection. */
export async function copySelectedTable(tab: TabWithId, source: SelectionSource, format: TableFormat): Promise<ToastMessage> {
  const settings = await loadSettings();
  let result;
  try {
    result = await callPage(tab.id, source.frameId, 'convertSelectedTable', format, settings);
  } catch {
    return notify(tab.id, { tone: 'error', title: "Can't read tables on this page", detail: UNREADABLE_PAGE });
  }
  if (result.status !== 'ok') {
    if (result.status === 'no-table') {
      return notify(tab.id, {
        tone: 'error',
        title: 'No table in the selection',
        detail: 'Select text inside a table, or click the Universal Copy toolbar button to pick a table on this page.',
      });
    }
    return notify(tab.id, { tone: 'error', title: 'Nothing is selected', detail: 'Select some text inside a table first.' });
  }
  if (!result.payload.text.trim()) {
    return notify(tab.id, { tone: 'error', title: 'This table is empty', detail: 'It has no visible text to copy.' });
  }
  if (!(await copyToClipboard(result.payload))) {
    return notify(tab.id, { tone: 'error', title: "Couldn't copy to the clipboard", detail: 'Please try again.' });
  }
  const parts = [tableSize(result.rows, result.columns)];
  if (result.overlapping > 1) parts.push(`the first of ${result.overlapping} tables in the selection`);
  if (result.truncated) parts.push('very large table: only the first part was copied');
  return notify(tab.id, {
    tone: result.overlapping > 1 || result.truncated ? 'info' : 'success',
    title: `Copied table as ${TABLE_FORMAT_LABELS[format]}`,
    detail: parts.join(' · '),
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
    await chrome.action.setBadgeBackgroundColor({ tabId, color: error ? '#dc3545' : '#0b7285' });
    await chrome.action.setBadgeText({ tabId, text: error ? '!' : '✓' });
    await chrome.action.setTitle({ tabId, title: `Universal Copy: ${message.title}` });
    if (!error) {
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
        chrome.action.setTitle({ tabId, title: 'Universal Copy' }).catch(() => undefined);
      }, 4000);
    }
  } catch (error) {
    console.error('Universal Copy: could not show the result', message, error);
  }
  return message;
}
