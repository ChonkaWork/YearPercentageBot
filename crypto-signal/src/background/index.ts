import { detectFromSelection } from '../core/detect';
import { PLAN_STORAGE_KEY } from '../core/plan';
import { ALERTS_KEY, setPendingAnalysis, WATCHLIST_KEY } from '../storage/store';
import { CHECK_ALARM, onNotificationClicked, runChecks, syncSchedule } from './monitor';

/**
 * Service worker:
 * - Context menu: "Analyze selected coin" detects a ticker in the selection, hands it to the
 *   popup through chrome.storage.session and opens the popup.
 * - Background alerts and watchlist (Pro, see ./monitor.ts): a chrome.alarms schedule that
 *   exists only while there is something to check, and notifications for fired alerts.
 * Market data for the popup is fetched by the popup itself.
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

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus();
  void syncSchedule().catch(logError('schedule'));
});

chrome.runtime.onStartup.addListener(() => void syncSchedule().catch(logError('schedule')));

// Alerts, watchlist or plan changed (from the popup or a future payments adapter): (un)schedule.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (ALERTS_KEY in changes || WATCHLIST_KEY in changes || 'settings' in changes || PLAN_STORAGE_KEY in changes) {
    void syncSchedule().catch(logError('schedule'));
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) void runChecks('alarm').catch(logError('check'));
});

chrome.notifications.onClicked.addListener((id) => void onNotificationClicked(id).catch(logError('notification')));

// "Check now" in the popup.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || (message as { type?: unknown } | null)?.type !== 'check-now') return false;
  runChecks('manual').then(sendResponse, (error: unknown) => {
    logError('check')(error);
    sendResponse(null);
  });
  return true;
});

function logError(what: string): (error: unknown) => void {
  return (error) => console.error(`CryptoSignal AI: ${what} failed`, error);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onContextMenuClick(info, tab).catch((error: unknown) => console.error('CryptoSignal AI: context menu failed', error));
});

if (__E2E__) {
  // Test-only hook: native context menus can't be clicked from automation.
  // Alarms fire on Chrome's schedule and notifications are clicked by a person, so the e2e
  // suite calls the same handlers directly.
  Object.assign(globalThis, {
    __cryptoSignalTest: {
      onContextMenuClick,
      runChecks,
      syncSchedule,
      fireAlarm: (name: string) => (name === CHECK_ALARM ? runChecks('alarm') : Promise.resolve(null)),
      onNotificationClicked,
    },
  });
}
