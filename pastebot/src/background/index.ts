import { openTarget } from '../core/destinations';
import { isDirectAction } from '../core/types';
import { ACTIONS } from '../templates';
import { isBackgroundRequest, type BackgroundRequest, type OpenResponse } from '../platform/messages';
import { copyToClipboard } from './clipboard';
import { availableTemplates, openPanel, runDirectAction, translateTarget } from './flows';
import { makePrompt } from './makePrompt';
import { MENU_KEYS, SETTINGS_KEY, loadSettings } from '../storage/store';

const MENU_ROOT = 'pastebot';
const MENU_MAKE = 'pastebot:make';
const ACTION_PREFIX = 'pastebot:action:';
const TEMPLATE_PREFIX = 'pastebot:template:';
const COMMAND_MAKE = 'make-prompt';

type TabWithId = chrome.tabs.Tab & { id: number };

/** Ids and titles of the menu items created last (read by the e2e test; native menus can't be inspected). */
let menuIds: string[] = [];
let menuTitles: Record<string, string> = {};

// Rebuilds can be triggered by install and by storage changes at the same time; run them in
// order so one rebuild's removeAll can't interleave with another's creates.
let menuQueue: Promise<unknown> = Promise.resolve();
function registerContextMenus(): Promise<void> {
  const run = menuQueue.then(buildContextMenus, buildContextMenus);
  menuQueue = run.catch((error: unknown) => console.error('Pastebot: menu rebuild failed', error));
  return run;
}

async function buildContextMenus(): Promise<void> {
  const [templates, settings] = await Promise.all([availableTemplates(), loadSettings()]);
  // Callback forms: promise support in contextMenus is newer than minimum_chrome_version.
  await new Promise<void>((resolve) =>
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      resolve();
    }),
  );
  const ids: string[] = [];
  const titles: Record<string, string> = {};
  const create = (properties: chrome.contextMenus.CreateProperties & { id: string }) =>
    new Promise<void>((resolve) => {
      ids.push(properties.id);
      if (properties.title) titles[properties.id] = properties.title;
      chrome.contextMenus.create({ contexts: ['selection'], ...properties }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  await create({ id: MENU_ROOT, title: 'Pastebot' });
  await create({ id: MENU_MAKE, parentId: MENU_ROOT, title: 'Make Prompt…' });
  await create({ id: 'pastebot:separator', parentId: MENU_ROOT, type: 'separator' });
  for (const action of ACTIONS) {
    if (action.id === 'custom') continue;
    const title = action.id === 'translate' ? `Translate to ${translateTarget(settings.translateTo)}` : action.label;
    await create({ id: `${ACTION_PREFIX}${action.id}`, parentId: MENU_ROOT, title });
  }
  if (templates.length > 0) {
    await create({ id: 'pastebot:separator-templates', parentId: MENU_ROOT, type: 'separator' });
    for (const template of templates) {
      // `%s` in a menu title is replaced by the selection; `%%` is a literal percent sign.
      await create({ id: `${TEMPLATE_PREFIX}${template.id}`, parentId: MENU_ROOT, title: template.name.replaceAll('%', '%%') });
    }
  }
  if (__E2E__) {
    menuIds = ids;
    menuTitles = titles;
  }
}

async function onContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (tab?.id === undefined || tab.id < 0) return;
  const source = { frameId: info.frameId ?? 0, selectionText: info.selectionText, pageUrl: info.pageUrl };
  const menuId = String(info.menuItemId);
  if (menuId === MENU_MAKE) return openPanel(tab as TabWithId, source);
  const action = menuId.startsWith(ACTION_PREFIX) ? menuId.slice(ACTION_PREFIX.length) : null;
  if (isDirectAction(action)) return runDirectAction(tab as TabWithId, source, { action });
  if (menuId.startsWith(TEMPLATE_PREFIX)) {
    const id = menuId.slice(TEMPLATE_PREFIX.length);
    const template = (await availableTemplates()).find((candidate) => candidate.id === id);
    // A stale menu item (template just deleted) still goes through makePrompt, which explains.
    return runDirectAction(tab as TabWithId, source, { template: template ?? { id, name: 'Template', asks: [] } });
  }
}

async function onCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  if (command !== COMMAND_MAKE) return;
  if (tab?.id === undefined || tab.id < 0) {
    await chrome.action.openPopup().catch(() => undefined);
    return;
  }
  await openPanel(tab as TabWithId, { frameId: 0 });
}

async function handleRequest(request: BackgroundRequest, sender: chrome.runtime.MessageSender) {
  switch (request.type) {
    case 'pastebot/make':
      return makePrompt({
        action: request.action,
        text: request.text,
        customInstruction: request.customInstruction,
        includePageContext: request.includePageContext,
        page: request.page ?? null,
        copy: request.copy,
        ...(request.templateId !== undefined ? { templateId: request.templateId } : {}),
        ...(request.variables !== undefined ? { variables: request.variables } : {}),
        ...(request.unmasked ? { unmasked: true } : {}),
      });
    case 'pastebot/copy':
      return { ok: await copyToClipboard(request.text) };
    case 'pastebot/open':
      return openDestination(request.destination, request.prompt, request.copy, sender.tab);
  }
}

/**
 * "Copy & open": the address comes from the fixed destination list, never from the message,
 * so a page can't make Pastebot open anything else. The tab opens next to the one it came from.
 */
async function openDestination(
  destination: Parameters<typeof openTarget>[0],
  prompt: string,
  copy: boolean,
  from?: chrome.tabs.Tab,
): Promise<OpenResponse> {
  const copied = copy ? await copyToClipboard(prompt) : true;
  const target = openTarget(destination, prompt);
  const placement = from?.id !== undefined && from.id >= 0 ? { index: from.index + 1, openerTabId: from.id, windowId: from.windowId } : {};
  try {
    await chrome.tabs.create({ url: target.url, active: true, ...placement });
    return { ok: true, copied, prefilled: target.prefilled };
  } catch {
    return { ok: false, copied, prefilled: false };
  }
}

chrome.runtime.onInstalled.addListener(() => void registerContextMenus());

// Templates are edited on the options page; the plan is set by a future payments adapter; the
// Translate item names the target language.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const settings = changes[SETTINGS_KEY];
  const translateChanged =
    settings !== undefined &&
    (settings.oldValue as { translateTo?: unknown } | undefined)?.translateTo !== (settings.newValue as { translateTo?: unknown } | undefined)?.translateTo;
  if (translateChanged || MENU_KEYS.some((key) => key in changes)) void registerContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onContextMenuClick(info, tab).catch((error: unknown) => console.error('Pastebot: context menu action failed', error));
});

chrome.commands.onCommand.addListener((command, tab) => {
  onCommand(command, tab).catch((error: unknown) => console.error('Pastebot: command failed', error));
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only our own extension pages and content scripts; no externally_connectable is declared.
  if (sender.id !== chrome.runtime.id || !isBackgroundRequest(message)) return false;
  handleRequest(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.error('Pastebot: request failed', error);
      sendResponse({ ok: false, code: 'INTERNAL', message: 'Something went wrong. Please try again.' });
    });
  return true;
});

if (__E2E__) {
  // Test-only hook: native context menus and browser shortcuts can't be clicked from automation.
  Object.assign(globalThis, {
    __pastebotTest: { onContextMenuClick, onCommand, menuIds: () => menuIds, menuTitles: () => menuTitles, rebuildMenus: registerContextMenus },
  });
}
