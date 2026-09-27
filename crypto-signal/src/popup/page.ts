import { detectCoin, type Detection } from '../core/detect';

export interface PageDetection {
  symbol: string;
  via: Detection['via'];
  host: string | null;
}

/**
 * Detects the coin on the tab the popup was opened from. Uses the tab's URL and title (granted
 * by activeTab when the user clicks the toolbar button) and injects a one-off function that
 * returns the first <h1> text, nothing else. Pages that can't be scripted (chrome://, the Web
 * Store) just skip the heading.
 */
export async function detectFromActiveTab(): Promise<PageDetection | null> {
  const tab = await targetTab();
  if (!tab?.url || !/^https?:/i.test(tab.url)) return null;
  const heading = tab.id === undefined ? '' : await readHeading(tab.id);
  const detection = detectCoin({ url: tab.url, title: tab.title ?? '', heading });
  if (!detection) return null;
  return { ...detection, host: hostOf(tab.url) };
}

async function targetTab(): Promise<chrome.tabs.Tab | null> {
  if (__E2E__) {
    // Test-only: the e2e suite opens popup.html in a tab and names the page tab to read.
    const id = Number(new URLSearchParams(location.search).get('tab'));
    if (Number.isInteger(id) && id > 0) return chrome.tabs.get(id).catch(() => null);
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

async function readHeading(tabId: number): Promise<string> {
  try {
    const injection = chrome.scripting.executeScript({ target: { tabId }, func: firstHeading });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 400));
    const results = await Promise.race([injection, timeout]);
    const value = results?.[0]?.result;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** Runs in the page (serialized by chrome.scripting): must not reference anything outside. */
function firstHeading(): string {
  const heading = document.querySelector('h1');
  return (heading?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
