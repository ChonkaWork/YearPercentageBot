import { isOffscreenCopyRequest } from '../platform/messages';
import { copyWithEvent, copyWithTextarea } from '../ui/clipboard';

/**
 * Offscreen document: its only job is writing to the clipboard for the service worker.
 * execCommand('copy') is used because the async Clipboard API needs a focused document,
 * which an offscreen document never is.
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isOffscreenCopyRequest(message)) return false;
  sendResponse({ ok: copyWithEvent(message.text) || copyWithTextarea(message.text) });
  return false;
});
