import { setPending } from '../storage/handoff';

export type PopupRequest = { kind: 'analyze'; url: string } | { kind: 'search'; query: string };

/**
 * Stores what to show, then opens the toolbar popup, which picks it up (like pastebot's
 * handOffToPopup). chrome.action.openPopup() needs Chrome 127+ and a focused browser window;
 * when there is none (e.g. a notification clicked while Chrome is in the background) the last
 * focused window is brought forward first. If that fails too, a badge asks the user to click the
 * toolbar button, and the popup picks the request up then (for 5 minutes).
 */
export async function handOffToPopup(tabId: number | undefined, request: PopupRequest): Promise<void> {
  try {
    await setPending(request);
  } catch {
    // Session storage unavailable: the popup still opens and detects the tab itself.
  }
  if (await tryOpenPopup()) return;
  const details = tabId !== undefined ? { tabId } : {};
  await chrome.action.setBadgeBackgroundColor({ ...details, color: '#2e5cff' }).catch(() => undefined);
  await chrome.action.setBadgeText({ ...details, text: '1' }).catch(() => undefined);
}

async function tryOpenPopup(): Promise<boolean> {
  try {
    await chrome.action.openPopup();
    return true;
  } catch {
    // No focused window, or Chrome < 127.
  }
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (window.id === undefined) return false;
    await chrome.windows.update(window.id, { focused: true });
    await chrome.action.openPopup({ windowId: window.id });
    return true;
  } catch {
    return false;
  }
}
