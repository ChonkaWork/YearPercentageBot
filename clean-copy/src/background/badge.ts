import { hostOf, scopeCovers, type AutoCleanScope } from '../core/sites';

/**
 * A small "ON" badge on the toolbar icon in tabs where auto-clean rewrites Ctrl+C, so it's
 * never a surprise. Tab URLs are only visible for sites Clean Copy has access to, which are
 * exactly the sites auto-clean can run on.
 */

export const AUTO_BADGE = 'ON';
const BRAND_COLOR = '#1971c2';

export async function updateBadge(tab: chrome.tabs.Tab, scope: AutoCleanScope): Promise<void> {
  if (tab.id === undefined || tab.id < 0) return;
  const tabId = tab.id;
  try {
    if (scopeCovers(scope, hostOf(tab.url))) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BRAND_COLOR });
      await chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' });
      await chrome.action.setBadgeText({ tabId, text: AUTO_BADGE });
      await chrome.action.setTitle({ tabId, title: 'Clean Copy: auto-clean is on here (Ctrl+C copies clean text)' });
    } else if ((await chrome.action.getBadgeText({ tabId })) === AUTO_BADGE) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'Clean Copy' });
    }
  } catch {
    // The tab went away.
  }
}

export async function refreshBadges(scope: AutoCleanScope): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  await Promise.all(tabs.map((tab) => updateBadge(tab, scope)));
}
