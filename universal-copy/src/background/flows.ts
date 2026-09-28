import {
  convertPlainText,
  SELECTION_FORMAT_LABELS,
  TABLE_FORMAT_LABELS,
  type ClipboardPayload,
  type SelectionFormat,
  type TableFormat,
} from '../core/convert';
import { pageLinkMarkdown } from '../core/pageLink';
import { proMessage } from '../core/plan';
import { buildQuote } from '../core/quote';
import type { Settings } from '../core/settings';
import { countWords, estimateTokens } from '../core/stats';
import { normalizePlainText } from '../core/text';
import type { ClipResult, DeepLink, SelectionResult } from '../page/index';
import type { ToastMessage } from '../page/toast';
import { callPage, convertQuoteInAnyFrame, convertSelectionInAnyFrame, readPageInfo } from '../platform/page';
import { canUse, loadEntitlements, loadSettings, setNotice } from '../storage/store';
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
  /** The page address Chrome reports (context menus), for pages that can't be read. */
  pageUrl?: string;
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

const QUOTE_NOTES: Record<DeepLink, { tone: ToastMessage['tone']; title: string; detail: string }> = {
  passage: { tone: 'success', title: 'Copied quote with link', detail: 'The link opens the page at this passage and highlights it.' },
  ambiguous: {
    tone: 'info',
    title: 'Copied quote with link',
    detail: 'The same passage appears more than once on this page, so the link opens the page without jumping to it.',
  },
  page: { tone: 'info', title: 'Copied quote with link', detail: "This text can't be linked to directly, so the link opens the page." },
  none: { tone: 'info', title: 'Copied quote', detail: 'This page has no web address to link to.' },
};

/** "Copy as quote with link": the selection as a quote, and a link that scrolls to it. */
export async function copyQuote(tab: TabWithId, source: SelectionSource): Promise<ToastMessage> {
  const settings = await loadSettings();
  let result: ClipResult | null = null;
  if (source.anyFrame) result = await convertQuoteInAnyFrame(tab.id, settings);
  else {
    try {
      result = await callPage(tab.id, source.frameId, 'convertQuote', settings);
    } catch {
      result = null;
    }
  }

  let payload: ClipboardPayload;
  let deepLink: DeepLink;
  let note: string | null = null;
  if (result && result.kind !== 'empty') {
    payload = result.payload;
    deepLink = result.deepLink ?? 'page';
    if (result.truncated) note = 'The selection is very large: only the first part was quoted.';
  } else if (source.selectionText?.trim()) {
    // The page can't be read: Chrome's plain selection text and the tab's own address.
    const text = normalizePlainText(source.selectionText);
    const quote = buildQuote({ markdown: text, text }, { title: tab.title ?? '', url: tab.url ?? source.pageUrl ?? '', fragment: null }, settings.quoteStyle);
    payload = quote.payload;
    deepLink = quote.link ? 'page' : 'none';
    if (!result) note = `Quoted as plain text. ${UNREADABLE_PAGE}`;
  } else {
    return notify(tab.id, { tone: 'error', title: 'Nothing is selected', detail: 'Select the passage you want to quote first.' });
  }

  if (!payload.text.trim()) {
    return notify(tab.id, { tone: 'error', title: 'Nothing to quote', detail: 'The selection has no visible text.' });
  }
  if (!(await copyToClipboard(payload))) {
    return notify(tab.id, { tone: 'error', title: "Couldn't copy to the clipboard", detail: 'Please try again.' });
  }
  const outcome = QUOTE_NOTES[deepLink];
  return notify(tab.id, { tone: note ? 'info' : outcome.tone, title: outcome.title, detail: note ?? outcome.detail });
}

/** "Copy article as Markdown": the page's main content, without selecting it. */
export async function copyArticle(tab: TabWithId): Promise<ToastMessage> {
  const settings = await loadSettings();
  let result: ClipResult;
  try {
    result = await callPage(tab.id, 0, 'convertArticle', 'markdown', settings);
  } catch {
    return notify(tab.id, { tone: 'error', title: "Can't read this page", detail: UNREADABLE_PAGE });
  }
  const markdown = result.payload.text;
  if (!markdown.trim()) {
    return notify(tab.id, { tone: 'error', title: 'No article text on this page', detail: 'It has no readable text to copy.' });
  }
  if (!(await copyToClipboard(result.payload))) {
    return notify(tab.id, { tone: 'error', title: "Couldn't copy to the clipboard", detail: 'Please try again.' });
  }
  const words = countWords(markdown);
  const size = `${formatCount(words)} ${plural(words, 'word')} · ~${formatCount(estimateTokens(markdown))} tokens`;
  if (!result.found) {
    return notify(tab.id, {
      tone: 'info',
      title: 'Copied page as Markdown',
      detail: `No single article stood out, so the whole page was copied without menus and ads. ${size}`,
    });
  }
  return notify(tab.id, {
    tone: result.truncated ? 'info' : 'success',
    title: 'Copied article as Markdown',
    detail: result.truncated ? `Very long page: only the first part was copied. ${size}` : size,
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

/** Pro: `[Page title](https://link)` for the whole page, tracking parameters removed. */
export async function copyPageLink(tab: TabWithId, pageUrl?: string): Promise<ToastMessage> {
  if (!canUse(await loadEntitlements(), 'page-link')) {
    return notify(tab.id, { tone: 'info', title: 'Pro feature', detail: `${proMessage('page-link')} See Settings → About Pro.` });
  }
  const info = await readPageInfo(tab, pageUrl);
  const payload = pageLinkMarkdown(info.title, info.url);
  if (!payload) {
    return notify(tab.id, { tone: 'error', title: 'No web address to link to', detail: 'Only http and https pages can be copied as a link.' });
  }
  if (!(await copyToClipboard(payload))) {
    return notify(tab.id, { tone: 'error', title: "Couldn't copy to the clipboard", detail: 'Please try again.' });
  }
  return notify(tab.id, { tone: 'success', title: 'Copied page link as Markdown', detail: payload.text });
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
