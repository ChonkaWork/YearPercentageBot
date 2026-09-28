import type { TableSummary } from '../page/reader';
import { POPUP_PORT } from '../platform/messages';
import { callPage } from '../platform/page';
import { state } from './context';

/**
 * Outlines (and scrolls to) the table whose card has the pointer, or else the keyboard
 * focus. The page removes the outline when this popup's port closes, i.e. when the popup
 * does.
 */

let hovered: TableSummary | null = null;
let focused: TableSummary | null = null;
let highlighted = -1;
let timer: number | undefined;
let suspended = false;

export function setHover(table: TableSummary | null, leaving?: TableSummary): void {
  if (table) hovered = table;
  else if (hovered === leaving) hovered = null;
  schedule();
}

export function setFocus(table: TableSummary | null, leaving?: TableSummary): void {
  if (table) focused = table;
  else if (focused === leaving) focused = null;
  schedule();
}

/** A recording outlines its own table from now on. */
export function suspendHighlight(): void {
  suspended = true;
  window.clearTimeout(timer);
}

function schedule(): void {
  if (suspended) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const target = hovered ?? focused;
    const index = target?.index ?? -1;
    if (index === highlighted || state.tabId === null) return;
    highlighted = index;
    callPage(state.tabId, 0, 'highlight', index, target?.signature ?? '').catch(() => undefined);
  }, 120);
}

let port: chrome.runtime.Port | null = null;

export function connectHighlight(): void {
  if (port || state.tabId === null) return;
  try {
    port = chrome.tabs.connect(state.tabId, { name: POPUP_PORT, frameId: 0 });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
    });
  } catch {
    port = null;
  }
}
