import { isBackgroundRequest } from '../platform/messages';
import { KEYS } from '../storage/store';
import { copyToClipboard } from './clipboard';
import { copyClean, notify, type TabWithId } from './flows';
import { syncAutoClean } from './sites';

export const MENU_COPY = 'cc:copy';
export const COMMAND_COPY = 'copy-clean';

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_COPY, title: 'Copy clean', contexts: ['selection'] }, () => void chrome.runtime.lastError);
  });
}

async function onContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (tab?.id === undefined || tab.id < 0 || info.menuItemId !== MENU_COPY) return undefined;
  return copyClean(tab as TabWithId, { frameId: info.frameId ?? 0, selectionText: info.selectionText });
}

async function onCommand(command: string, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (command !== COMMAND_COPY) return undefined;
  if (tab?.id === undefined || tab.id < 0) {
    // No page to copy from (e.g. focus is in the address bar of a new tab): show the popup.
    return chrome.action.openPopup().catch(() => undefined);
  }
  return copyClean(tab as TabWithId, { frameId: 0, anyFrame: true });
}

function sync(): void {
  syncAutoClean().catch((error: unknown) => console.error('Clean Copy: auto-clean registration failed', error));
}

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus();
  sync();
});
chrome.runtime.onStartup.addListener(sync);
chrome.permissions.onAdded.addListener(sync);
chrome.permissions.onRemoved.addListener(sync);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (KEYS.sites in changes || KEYS.plan in changes)) sync();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onContextMenuClick(info, tab).catch((error: unknown) => {
    console.error('Clean Copy: context menu action failed', error);
    if (tab?.id !== undefined) void notify(tab.id, { tone: 'error', title: 'Something went wrong', detail: 'Please try again.' });
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  onCommand(command, tab).catch((error: unknown) => {
    console.error('Clean Copy: shortcut failed', error);
    if (tab?.id !== undefined) void notify(tab.id, { tone: 'error', title: 'Something went wrong', detail: 'Please try again.' });
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only our own extension pages; no externally_connectable is declared.
  if (sender.id !== chrome.runtime.id || !isBackgroundRequest(message)) return false;
  if (message.type === 'cc/copy') {
    copyToClipboard(message.text)
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
  } else {
    syncAutoClean()
      .then((active) => sendResponse({ ok: true, active }))
      .catch(() => sendResponse({ ok: false, active: [] }));
  }
  return true;
});

if (__E2E__) {
  // Test-only hook: native context menus and browser shortcuts can't be clicked from automation.
  Object.assign(globalThis, { __cleanCopyTest: { onContextMenuClick, onCommand, syncAutoClean } });
}
