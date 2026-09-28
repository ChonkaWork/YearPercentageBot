import { ALERT_ALARM } from '../core/alertCheck';
import { normalizeQuery } from '../core/search';
import { STORAGE_KEYS } from '../storage/store';
import { onNotificationClicked, runAlertCheck, syncAlarm } from './alerts';
import { handOffToPopup } from './popup';

/**
 * Service worker:
 *
 *   Context menu, on a Polymarket market page:  Polymarket AI → Analyze this market
 *   Context menu, on any selected text:         Polymarket AI → Analyze this market: “…” (search)
 *   Background alerts (Pro):                    chrome.alarms → check watchlist → notification
 *
 * The context menu and notification clicks hand off to the toolbar popup.
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

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus();
  void syncAlarm().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => void syncAlarm().catch(() => undefined));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onContextMenuClick(info, tab).catch((error: unknown) => console.error('Polymarket AI: context menu action failed', error));
});

function onAlarm(alarm: chrome.alarms.Alarm): Promise<unknown> {
  return alarm.name === ALERT_ALARM ? runAlertCheck() : Promise.resolve(null);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  onAlarm(alarm).catch((error: unknown) => console.error('Polymarket AI: alert check failed', error));
});

chrome.notifications.onClicked.addListener((id) => {
  onNotificationClicked(id).catch((error: unknown) => console.error('Polymarket AI: opening the alert failed', error));
});

// Alerts switched on or off, markets removed, plan changed: add or remove the alarm.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (STORAGE_KEYS.watchlist in changes || STORAGE_KEYS.plan in changes || (__E2E__ && 'e2e:earlyAccess' in changes)) void syncAlarm().catch(() => undefined);
});

if (__E2E__) {
  // Test-only hook: native context menus, alarms and notification clicks can't be triggered
  // from automation, so the test calls the handlers Chrome would call.
  Object.assign(globalThis, { __pmTest: { onContextMenuClick, onAlarm, onNotificationClicked, syncAlarm } });
}
