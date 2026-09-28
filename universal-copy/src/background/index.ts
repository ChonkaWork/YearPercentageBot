import { isSelectionFormat, isTableFormat } from '../core/convert';
import { isBackgroundRequest } from '../platform/messages';
import { loadSettings } from '../storage/store';
import { copyToClipboard } from './clipboard';
import { copyArticle, copyPageLink, copyQuote, copySelectedTable, copySelection, notify, type TabWithId } from './flows';

export const MENU_ROOT = 'uc';
export const MENU_TABLE = 'uc:table';
/** Right-click on the page itself (no selection, link or image). */
export const MENU_PAGE_LINK = 'uc:page-link';
const MENU_PAGE_LINK_IN_SELECTION = 'uc:page-link:selection';
export const MENU_QUOTE = 'uc:quote';
/** Right-click on the page itself: the main article as Markdown. */
export const MENU_ARTICLE = 'uc:article';
const SELECTION_PREFIX = 'uc:copy:';
const TABLE_PREFIX = 'uc:table:';
export const COMMAND_COPY = 'copy-selection';
export const COMMAND_QUOTE = 'copy-quote';

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    const create = (properties: chrome.contextMenus.CreateProperties) =>
      chrome.contextMenus.create({ contexts: ['selection'], ...properties }, () => void chrome.runtime.lastError);
    create({ id: MENU_ROOT, title: 'Universal Copy' });
    create({ id: `${SELECTION_PREFIX}text`, parentId: MENU_ROOT, title: 'Copy as clean text' });
    create({ id: `${SELECTION_PREFIX}markdown`, parentId: MENU_ROOT, title: 'Copy as Markdown' });
    create({ id: `${SELECTION_PREFIX}html`, parentId: MENU_ROOT, title: 'Copy as HTML (clean)' });
    create({ id: MENU_QUOTE, parentId: MENU_ROOT, title: 'Copy as quote with link' });
    create({ id: 'uc:separator', parentId: MENU_ROOT, type: 'separator' });
    create({ id: MENU_TABLE, parentId: MENU_ROOT, title: 'Copy table as' });
    create({ id: `${TABLE_PREFIX}csv`, parentId: MENU_TABLE, title: 'CSV' });
    create({ id: `${TABLE_PREFIX}tsv`, parentId: MENU_TABLE, title: 'TSV (Excel, Sheets)' });
    create({ id: `${TABLE_PREFIX}markdown`, parentId: MENU_TABLE, title: 'Markdown' });
    create({ id: `${TABLE_PREFIX}json`, parentId: MENU_TABLE, title: 'JSON' });
    create({ id: 'uc:separator-page', parentId: MENU_ROOT, type: 'separator' });
    create({ id: MENU_PAGE_LINK_IN_SELECTION, parentId: MENU_ROOT, title: 'Copy page link as Markdown' });
    create({ id: MENU_ARTICLE, contexts: ['page'], title: 'Copy article as Markdown' });
    create({ id: MENU_PAGE_LINK, contexts: ['page'], title: 'Copy page link as Markdown' });
  });
}

async function onContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (tab?.id === undefined || tab.id < 0) return undefined;
  const source = { frameId: info.frameId ?? 0, selectionText: info.selectionText, pageUrl: info.pageUrl };
  const id = String(info.menuItemId);
  if (id === MENU_PAGE_LINK || id === MENU_PAGE_LINK_IN_SELECTION) return copyPageLink(tab as TabWithId, info.pageUrl);
  if (id === MENU_QUOTE) return copyQuote(tab as TabWithId, source);
  if (id === MENU_ARTICLE) return copyArticle(tab as TabWithId);
  if (id.startsWith(SELECTION_PREFIX)) {
    const format = id.slice(SELECTION_PREFIX.length);
    if (isSelectionFormat(format)) return copySelection(tab as TabWithId, source, format);
  }
  if (id.startsWith(TABLE_PREFIX)) {
    const format = id.slice(TABLE_PREFIX.length);
    if (isTableFormat(format)) return copySelectedTable(tab as TabWithId, source, format);
  }
  return undefined;
}

async function onCommand(command: string, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (command !== COMMAND_COPY && command !== COMMAND_QUOTE) return undefined;
  if (tab?.id === undefined || tab.id < 0) {
    // No page to copy from (e.g. focus is in the address bar of a new tab): show the popup.
    return chrome.action.openPopup().catch(() => undefined);
  }
  if (command === COMMAND_QUOTE) return copyQuote(tab as TabWithId, { frameId: 0, anyFrame: true });
  const { shortcutFormat } = await loadSettings();
  return copySelection(tab as TabWithId, { frameId: 0, anyFrame: true }, shortcutFormat);
}

chrome.runtime.onInstalled.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onContextMenuClick(info, tab).catch((error: unknown) => {
    console.error('Universal Copy: context menu action failed', error);
    if (tab?.id !== undefined) void notify(tab.id, { tone: 'error', title: 'Something went wrong', detail: 'Please try again.' });
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  onCommand(command, tab).catch((error: unknown) => {
    console.error('Universal Copy: shortcut failed', error);
    if (tab?.id !== undefined) void notify(tab.id, { tone: 'error', title: 'Something went wrong', detail: 'Please try again.' });
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only our own extension pages; no externally_connectable is declared.
  if (sender.id !== chrome.runtime.id || !isBackgroundRequest(message)) return false;
  copyToClipboard(message.payload)
    .then((ok) => sendResponse({ ok }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

if (__E2E__) {
  // Test-only hook: native context menus and browser shortcuts can't be clicked from automation.
  Object.assign(globalThis, { __universalCopyTest: { onContextMenuClick, onCommand } });
}
