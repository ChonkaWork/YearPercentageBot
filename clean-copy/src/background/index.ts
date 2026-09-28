import { prepareLastCopy, sanitizeLastCopy } from '../core/lastCopy';
import { hostOf } from '../core/sites';
import { isBackgroundRequest, isPageOnlyRequest } from '../platform/messages';
import { KEYS, saveLastCopy } from '../storage/store';
import { updateBadge } from './badge';
import { copyToClipboard } from './clipboard';
import { cleanClipboardAfterGrant, cleanClipboardNow, clipboardMessage } from './clipboardClean';
import { copyClean, notify, restoreOriginal, type TabWithId } from './flows';
import { currentScope, syncAutoClean } from './sites';

export const MENU_COPY = 'cc:copy';
export const COMMAND_COPY = 'copy-clean';
export const COMMAND_CLEAN_CLIPBOARD = 'clean-clipboard';

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_COPY, title: 'Copy clean', contexts: ['selection'] }, () => void chrome.runtime.lastError);
  });
}

async function onContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (tab?.id === undefined || tab.id < 0 || info.menuItemId !== MENU_COPY) return undefined;
  return copyClean(tab as TabWithId, { frameId: info.frameId ?? 0, selectionText: info.selectionText, via: 'menu' });
}

async function onCommand(command: string, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (command === COMMAND_CLEAN_CLIPBOARD) {
    const outcome = await cleanClipboardNow();
    if (tab?.id !== undefined && tab.id >= 0) await notify(tab.id, clipboardMessage(outcome));
    else if (outcome.status === 'needs-permission') await chrome.action.openPopup().catch(() => undefined);
    return outcome;
  }
  if (command !== COMMAND_COPY) return undefined;
  if (tab?.id === undefined || tab.id < 0) {
    // No page to copy from (e.g. focus is in the address bar of a new tab): show the popup.
    return chrome.action.openPopup().catch(() => undefined);
  }
  return copyClean(tab as TabWithId, { frameId: 0, anyFrame: true, via: 'shortcut' });
}

/** Clipboard access was just granted: finish a "Clean clipboard" the popup couldn't (it may have closed). */
async function onClipboardGranted(): Promise<void> {
  const outcome = await cleanClipboardAfterGrant(false);
  if (!outcome) return;
  const popups = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] }).catch(() => []);
  if (popups.length > 0) return; // The popup is open and shows the result itself.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== undefined) await notify(tab.id, clipboardMessage(outcome));
}

function sync(): void {
  syncAutoClean().catch((error: unknown) => console.error('Clean Copy: auto-clean registration failed', error));
}

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus();
  sync();
});
chrome.runtime.onStartup.addListener(sync);
chrome.permissions.onAdded.addListener((permissions) => {
  sync();
  if (permissions.permissions?.includes('clipboardRead')) void onClipboardGranted().catch(() => undefined);
});
chrome.permissions.onRemoved.addListener(sync);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (KEYS.sites in changes || KEYS.allSites in changes || KEYS.plan in changes)) sync();
});

// The "ON" badge follows navigation: set on pages where auto-clean runs, cleared elsewhere.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete' && changeInfo.url === undefined) return;
  currentScope()
    .then((scope) => updateBadge(tab, scope))
    .catch(() => undefined);
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
  // Only our own pages and content scripts; no externally_connectable is declared.
  if (sender.id !== chrome.runtime.id || !isBackgroundRequest(message)) return false;
  // Popup and settings requests must come from an extension page, not from a script in a web page.
  if (isPageOnlyRequest(message) && !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  const reply = (work: Promise<unknown>, fallback: unknown) => {
    work.then(sendResponse).catch(() => sendResponse(fallback));
    return true;
  };
  switch (message.type) {
    case 'cc/copy':
      return reply(copyToClipboard(message.text).then((ok) => ({ ok })), { ok: false });
    case 'cc/sync-sites':
      return reply(
        syncAutoClean().then((scope) => ({ ok: true, scope })),
        { ok: false },
      );
    case 'cc/record-copy': {
      // Auto-clean in a page: keep the copy for Undo and "Show changes". The host comes from
      // the sender, not from the page.
      const incoming = sanitizeLastCopy(message.copy);
      if (!incoming) return false;
      const copy = prepareLastCopy({ ...incoming, via: 'auto', host: hostOf(sender.url) });
      return reply(saveLastCopy(copy).then(() => ({ ok: true })), { ok: false });
    }
    case 'cc/undo':
      return reply(restoreOriginal(message.id), { ok: false, reason: 'clipboard' });
    case 'cc/clean-clipboard':
      return reply(message.afterGrant ? cleanClipboardAfterGrant(true) : cleanClipboardNow(), { status: 'error', message: 'Please try again.' });
    default:
      return false;
  }
});

if (__E2E__) {
  // Test-only hook: native context menus and browser shortcuts can't be clicked from automation.
  Object.assign(globalThis, { __cleanCopyTest: { onContextMenuClick, onCommand, syncAutoClean } });
}
