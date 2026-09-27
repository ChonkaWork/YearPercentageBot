import { detectFromSelection } from '../core/detect';
import { setPendingAnalysis } from '../storage/store';

/**
 * Service worker: only the context menu lives here. "Analyze selected coin" detects a ticker
 * in the selection, hands it to the popup through chrome.storage.session and opens the popup.
 * Market data is fetched by the popup itself.
 */

const MENU_ROOT = 'cryptosignal';
const MENU_ANALYZE = 'cryptosignal:analyze';
const BADGE_COLOR = '#f0b90b';

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    const create = (properties: chrome.contextMenus.CreateProperties) =>
      chrome.contextMenus.create({ contexts: ['selection'], ...properties }, () => void chrome.runtime.lastError);
    create({ id: MENU_ROOT, title: 'CryptoSignal AI' });
    create({ id: MENU_ANALYZE, parentId: MENU_ROOT, title: 'Analyze selected coin' });
  });
}

async function onContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (info.menuItemId !== MENU_ANALYZE) return;
  const selection = (info.selectionText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const symbol = detectFromSelection(selection);
  try {
    await setPendingAnalysis({ symbol, selection });
  } catch {
    // Session storage unavailable: the popup still opens with its usual coin.
  }
  await handOffToPopup(tab?.id);
}

/**
 * chrome.action.openPopup() needs Chrome 127+ and a focused window. When it can't open,
 * a badge on the toolbar icon tells the user where to click; the request waits for 5 minutes.
 */
async function handOffToPopup(tabId: number | undefined): Promise<void> {
  try {
    await chrome.action.openPopup();
    return;
  } catch {
    // Fall through to the badge.
  }
  try {
    const target = tabId !== undefined && tabId >= 0 ? { tabId } : {};
    await chrome.action.setBadgeBackgroundColor({ ...target, color: BADGE_COLOR });
    await chrome.action.setBadgeTextColor?.({ ...target, color: '#0b0e11' });
    await chrome.action.setBadgeText({ ...target, text: '1' });
    await chrome.action.setTitle({ ...target, title: 'CryptoSignal AI: click to see the analysis' });
  } catch {
    // Tab closed.
  }
}

chrome.runtime.onInstalled.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onContextMenuClick(info, tab).catch((error: unknown) => console.error('CryptoSignal AI: context menu failed', error));
});

if (__E2E__) {
  // Test-only hook: native context menus can't be clicked from automation.
  Object.assign(globalThis, { __cryptoSignalTest: { onContextMenuClick } });
}
