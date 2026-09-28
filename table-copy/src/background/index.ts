import { isTableFormat } from '../core/formats';
import { isBackgroundRequest } from '../platform/messages';
import { copyToClipboard } from './clipboard';
import { addSelectedToBasket, copySelectedTable, notify, type TabWithId } from './flows';

export const MENU_ROOT = 'tc';
export const MENU_BASKET = 'tc:basket';
const COPY_PREFIX = 'tc:copy:';

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    const create = (properties: chrome.contextMenus.CreateProperties) =>
      chrome.contextMenus.create({ contexts: ['selection'], ...properties }, () => void chrome.runtime.lastError);
    create({ id: MENU_ROOT, title: 'Table Copy' });
    create({ id: `${COPY_PREFIX}csv`, parentId: MENU_ROOT, title: 'Copy table as CSV' });
    create({ id: `${COPY_PREFIX}tsv`, parentId: MENU_ROOT, title: 'Copy table as TSV (Excel, Sheets)' });
    create({ id: `${COPY_PREFIX}markdown`, parentId: MENU_ROOT, title: 'Copy table as Markdown' });
    create({ id: `${COPY_PREFIX}json`, parentId: MENU_ROOT, title: 'Copy table as JSON' });
    create({ id: 'tc:separator', parentId: MENU_ROOT, type: 'separator' });
    create({ id: MENU_BASKET, parentId: MENU_ROOT, title: 'Add table to basket (merge later)' });
  });
}

async function onContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (tab?.id === undefined || tab.id < 0) return undefined;
  const frameId = info.frameId ?? 0;
  const id = String(info.menuItemId);
  if (id === MENU_BASKET) return addSelectedToBasket(tab as TabWithId, frameId);
  if (id.startsWith(COPY_PREFIX)) {
    const format = id.slice(COPY_PREFIX.length);
    if (isTableFormat(format)) return copySelectedTable(tab as TabWithId, frameId, format);
  }
  return undefined;
}

chrome.runtime.onInstalled.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onContextMenuClick(info, tab).catch((error: unknown) => {
    console.error('Table Copy: context menu action failed', error);
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
  // Test-only hook: native context menus can't be clicked from automation.
  Object.assign(globalThis, { __tableCopyTest: { onContextMenuClick } });
}
