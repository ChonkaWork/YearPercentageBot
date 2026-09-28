import { isOffscreenRequest, type OffscreenPasteResponse } from '../platform/messages';
import { copyWithEvent, copyWithTextarea, readWithPaste } from '../ui/clipboard';

/**
 * Offscreen document: its only job is the clipboard for the service worker, which has none.
 * execCommand('copy'/'paste') is used because the async Clipboard API needs a focused
 * document, which an offscreen document never is. Reading needs the optional clipboardRead
 * permission, granted from the popup ("Clean clipboard").
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isOffscreenRequest(message)) return false;
  if (message.type === 'cc/offscreen-paste') {
    const read = readWithPaste();
    const response: OffscreenPasteResponse = read ? { ok: true, text: read.text, html: read.html } : { ok: false };
    sendResponse(response);
    return false;
  }
  if (copyWithEvent(message.text, document, message.html)) sendResponse({ ok: true, withHtml: Boolean(message.html) });
  else sendResponse({ ok: copyWithTextarea(message.text), withHtml: false });
  return false;
});
