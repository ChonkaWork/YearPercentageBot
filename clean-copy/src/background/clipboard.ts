import type { OffscreenCopyRequest, OffscreenPasteRequest, OffscreenPasteResponse } from '../platform/messages';

/**
 * A service worker has no DOM and no clipboard. The MV3 way to use the clipboard from the
 * background is an offscreen document (reason CLIPBOARD). It works regardless of the page:
 * http pages, strict CSP, pages without focus.
 */

const OFFSCREEN_PATH = 'offscreen.html';
let creating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (existing.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Copy the cleaned text to the clipboard, and read it for "Clean clipboard".',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  return (await writeClipboard(text)).ok;
}

/** Writes text, and HTML next to it when given (restoring an original). */
export async function writeClipboard(text: string, html?: string): Promise<{ ok: boolean; withHtml: boolean }> {
  try {
    await ensureOffscreenDocument();
    const request: OffscreenCopyRequest = { target: 'offscreen', type: 'cc/offscreen-copy', text };
    if (html) request.html = html;
    const response = (await chrome.runtime.sendMessage(request)) as { ok?: unknown; withHtml?: unknown } | undefined;
    return { ok: response?.ok === true, withHtml: response?.withHtml === true };
  } catch (error) {
    console.error('Clean Copy: clipboard write failed', error);
    return { ok: false, withHtml: false };
  }
}

/** The clipboard's text and HTML. Null when it can't be read (no clipboardRead permission). */
export async function readClipboard(): Promise<{ text: string; html: string } | null> {
  try {
    await ensureOffscreenDocument();
    const request: OffscreenPasteRequest = { target: 'offscreen', type: 'cc/offscreen-paste' };
    const response = (await chrome.runtime.sendMessage(request)) as OffscreenPasteResponse | undefined;
    if (!response?.ok) return null;
    return { text: response.text ?? '', html: response.html ?? '' };
  } catch (error) {
    console.error('Clean Copy: clipboard read failed', error);
    return null;
  }
}
