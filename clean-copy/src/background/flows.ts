import { cleanCopy, describeClean } from '../core/cleaner';
import { hasFeature } from '../core/plan';
import type { ToastMessage } from '../page/toast';
import type { PageCleanResult } from '../page/selection';
import { callPage, cleanInAnyFrame } from '../platform/page';
import { loadState, setNotice } from '../storage/store';
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

export const BRAND_COLOR = '#1971c2';

/** "Copy clean": the selection as clean plain text, then a confirmation in the page. */
export async function copyClean(tab: TabWithId, source: SelectionSource): Promise<ToastMessage> {
  const state = await loadState();
  const rules = hasFeature(state.plan, 'custom-rules') ? state.rules : null;
  let result: PageCleanResult | null;
  if (source.anyFrame) {
    result = await cleanInAnyFrame(tab.id, state.settings, rules);
  } else {
    try {
      result = await callPage(tab.id, source.frameId, 'clean', state.settings, rules);
    } catch {
      result = null;
    }
  }

  let text: string;
  let detail: string;
  let tone: ToastMessage['tone'] = 'success';
  if (result && result.kind !== 'empty') {
    text = result.text;
    detail = describeClean(result.stats, text.length);
    if (result.truncated) {
      detail = `The selection is very large: only the first part was copied. ${detail}`;
      tone = 'info';
    }
  } else if (source.selectionText?.trim()) {
    const cleaned = cleanCopy({ kind: 'plain', text: source.selectionText }, state.settings, rules);
    text = cleaned.text;
    detail = result ? "The selection couldn't be read here, so Chrome's plain selection text was cleaned." : `Copied Chrome's plain selection text. ${UNREADABLE_PAGE}`;
    tone = 'info';
  } else {
    return notify(tab.id, { tone: 'error', title: 'Nothing is selected', detail: 'Select some text on the page first.' });
  }
  if (result?.stats.rulesStopped) tone = 'info';

  if (!text.trim()) {
    return notify(tab.id, {
      tone: 'error',
      title: 'Nothing to copy',
      detail: 'The selection has no visible text (only images, buttons or hidden content).',
    });
  }
  if (!(await copyToClipboard(text))) {
    return notify(tab.id, { tone: 'error', title: "Couldn't copy to the clipboard", detail: 'Please try again.' });
  }
  return notify(tab.id, { tone, title: 'Copied clean text', detail });
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
    await chrome.action.setBadgeBackgroundColor({ tabId, color: error ? '#dc3545' : BRAND_COLOR });
    await chrome.action.setBadgeText({ tabId, text: error ? '!' : '✓' });
    await chrome.action.setTitle({ tabId, title: `Clean Copy: ${message.title}` });
    if (!error) {
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
        chrome.action.setTitle({ tabId, title: 'Clean Copy' }).catch(() => undefined);
      }, 4000);
    }
  } catch (error) {
    console.error('Clean Copy: could not show the result', message, error);
  }
  return message;
}
