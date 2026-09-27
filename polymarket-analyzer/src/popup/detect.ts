import { isPolymarketUrl, parseMarketUrl } from '../core/slug';
import type { MarketRef } from '../core/types';

export interface TabInfo {
  id: number | undefined;
  url: string | undefined;
}

/**
 * The tab the popup was opened over. With activeTab, Chrome exposes its URL once the user
 * clicks the toolbar button (or the context menu). No "tabs" permission is needed.
 */
export async function targetTab(): Promise<TabInfo | null> {
  try {
    if (__E2E__) {
      // Test build only: the popup is opened as a normal page, so the tab under test is passed in.
      const id = Number(new URLSearchParams(location.search).get('tab'));
      if (id) {
        const tab = await chrome.tabs.get(id);
        return { id: tab.id, url: tab.url };
      }
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? { id: tab.id, url: tab.url } : null;
  } catch {
    return null;
  }
}

/**
 * Fallback for Polymarket pages whose URL has no market slug (e.g. sports game pages): read
 * the page's canonical link. One small injected function, run only after the user opened the
 * popup on that tab; nothing else on the page is read.
 */
export async function refFromCanonical(tab: TabInfo): Promise<MarketRef | null> {
  if (tab.id === undefined || !isPolymarketUrl(tab.url)) return null;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => [
        document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
        document.querySelector('meta[property="og:url"]')?.getAttribute('content') ?? null,
      ],
    });
    const candidates = Array.isArray(injection?.result) ? (injection.result as unknown[]) : [];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length > 2048) continue;
      try {
        const ref = parseMarketUrl(new URL(candidate, tab.url).href);
        if (ref) return ref;
      } catch {
        // Not a URL.
      }
    }
  } catch {
    // The page can't be scripted.
  }
  return null;
}
