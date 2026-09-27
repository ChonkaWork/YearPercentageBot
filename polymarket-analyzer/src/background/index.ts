import { normalizeQuery } from '../core/search';
import { setPending } from '../storage/handoff';

/**
 * Service worker: only the context menu. All market data is fetched by the popup.
 *
 *   On a Polymarket market page:  Polymarket AI → Analyze this market
 *   On any selected text:         Polymarket AI → Analyze this market: “…” (searches for the text)
 *
 * Both hand off to the toolbar popup (like pastebot's handOffToPopup).
 */

const PAGE_ROOT = 'pm-ai:page';
const ANALYZE_PAGE = 'pm-ai:analyze-page';
const SELECTION_ROOT = 'pm-ai:selection';
const ANALYZE_SELECTION = 'pm-ai:analyze-selection';

/** Market pages only (documentUrlPatterns needs no host permission). */
const MARKET_PAGES = ['event', 'market'].flatMap((kind) => [
  `https://polymarket.com/${kind}/*`,
  `https://www.polymarket.com/${kind}/*`,
  `https://polymarket.com/*/${kind}/*`,
  `https://www.polymarket.com/*/${kind}/*`,
]);

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    const create = (properties: chrome.contextMenus.CreateProperties) =>
      chrome.contextMenus.create(properties, () => void chrome.runtime.lastError);
    create({ id: PAGE_ROOT, title: 'Polymarket AI', contexts: ['page'], documentUrlPatterns: MARKET_PAGES });
    create({ id: ANALYZE_PAGE, parentId: PAGE_ROOT, title: 'Analyze this market', contexts: ['page'], documentUrlPatterns: MARKET_PAGES });
    create({ id: SELECTION_ROOT, title: 'Polymarket AI', contexts: ['selection'] });
    create({ id: ANALYZE_SELECTION, parentId: SELECTION_ROOT, title: 'Analyze this market: “%s”', contexts: ['selection'] });
  });
}

async function onContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  const tabId = tab?.id !== undefined && tab.id >= 0 ? tab.id : undefined;
  if (info.menuItemId === ANALYZE_PAGE) {
    const url = info.pageUrl || tab?.url;
    if (url) await handOffToPopup(tabId, { kind: 'analyze', url });
    return;
  }
  if (info.menuItemId === ANALYZE_SELECTION) {
    const query = normalizeQuery(info.selectionText ?? '');
    if (query) await handOffToPopup(tabId, { kind: 'search', query });
  }
}

/**
 * Stores what to show, then opens the toolbar popup, which picks it up.
 * chrome.action.openPopup() needs Chrome 127+; older versions get a badge instead.
 */
async function handOffToPopup(tabId: number | undefined, pending: { kind: 'analyze'; url: string } | { kind: 'search'; query: string }): Promise<void> {
  try {
    await setPending(pending);
  } catch {
    // Session storage unavailable: the popup still opens and detects the tab itself.
  }
  try {
    await chrome.action.openPopup();
  } catch {
    const details = tabId !== undefined ? { tabId } : {};
    await chrome.action.setBadgeBackgroundColor({ ...details, color: '#2e5cff' }).catch(() => undefined);
    await chrome.action.setBadgeText({ ...details, text: '1' }).catch(() => undefined);
  }
}

chrome.runtime.onInstalled.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onContextMenuClick(info, tab).catch((error: unknown) => console.error('Polymarket AI: context menu action failed', error));
});

if (__E2E__) {
  // Test-only hook: native context menus can't be clicked from automation.
  Object.assign(globalThis, { __pmTest: { onContextMenuClick } });
}
