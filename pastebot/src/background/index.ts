import { isDirectAction } from '../core/types';
import { ACTIONS } from '../templates';
import { isBackgroundRequest, type BackgroundRequest } from '../platform/messages';
import { copyToClipboard } from './clipboard';
import { openPanel, runDirectAction } from './flows';
import { makePrompt } from './makePrompt';

const MENU_ROOT = 'pastebot';
const MENU_MAKE = 'pastebot:make';
const ACTION_PREFIX = 'pastebot:action:';
const COMMAND_MAKE = 'make-prompt';

type TabWithId = chrome.tabs.Tab & { id: number };

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    const create = (properties: chrome.contextMenus.CreateProperties) =>
      chrome.contextMenus.create({ contexts: ['selection'], ...properties }, () => void chrome.runtime.lastError);
    create({ id: MENU_ROOT, title: 'Pastebot' });
    create({ id: MENU_MAKE, parentId: MENU_ROOT, title: 'Make Prompt…' });
    create({ id: 'pastebot:separator', parentId: MENU_ROOT, type: 'separator' });
    for (const action of ACTIONS) {
      if (action.id === 'custom') continue;
      create({ id: `${ACTION_PREFIX}${action.id}`, parentId: MENU_ROOT, title: action.label });
    }
  });
}

async function onContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (tab?.id === undefined || tab.id < 0) return;
  const source = { frameId: info.frameId ?? 0, selectionText: info.selectionText, pageUrl: info.pageUrl };
  const menuId = String(info.menuItemId);
  if (menuId === MENU_MAKE) return openPanel(tab as TabWithId, source);
  const action = menuId.startsWith(ACTION_PREFIX) ? menuId.slice(ACTION_PREFIX.length) : null;
  if (isDirectAction(action)) return runDirectAction(tab as TabWithId, source, action);
}

async function onCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  if (command !== COMMAND_MAKE) return;
  if (tab?.id === undefined || tab.id < 0) {
    await chrome.action.openPopup().catch(() => undefined);
    return;
  }
  await openPanel(tab as TabWithId, { frameId: 0 });
}

async function handleRequest(request: BackgroundRequest) {
  switch (request.type) {
    case 'pastebot/make':
      return makePrompt({
        action: request.action,
        text: request.text,
        customInstruction: request.customInstruction,
        includePageContext: request.includePageContext,
        page: request.page ?? null,
        copy: request.copy,
      });
    case 'pastebot/copy':
      return { ok: await copyToClipboard(request.text) };
  }
}

chrome.runtime.onInstalled.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onContextMenuClick(info, tab).catch((error: unknown) => console.error('Pastebot: context menu action failed', error));
});

chrome.commands.onCommand.addListener((command, tab) => {
  onCommand(command, tab).catch((error: unknown) => console.error('Pastebot: command failed', error));
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only our own extension pages and content scripts; no externally_connectable is declared.
  if (sender.id !== chrome.runtime.id || !isBackgroundRequest(message)) return false;
  handleRequest(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.error('Pastebot: request failed', error);
      sendResponse({ ok: false, code: 'INTERNAL', message: 'Something went wrong. Please try again.' });
    });
  return true;
});

if (__E2E__) {
  // Test-only hook: native context menus and browser shortcuts can't be clicked from automation.
  Object.assign(globalThis, { __pastebotTest: { onContextMenuClick, onCommand } });
}
