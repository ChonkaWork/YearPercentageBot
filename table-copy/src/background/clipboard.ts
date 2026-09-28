import type { ClipboardPayload } from '../core/formats';
import type { OffscreenCopyRequest } from '../platform/messages';

/**
 * A service worker has no DOM and no clipboard. The MV3 way to write to the clipboard
 * from the background is an offscreen document (reason CLIPBOARD). It works regardless of
 * the page: http pages, strict CSP, pages without focus.
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
      justification: 'Copy tables as CSV, TSV, Markdown or JSON to the clipboard.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export async function copyToClipboard(payload: ClipboardPayload): Promise<boolean> {
  try {
    await ensureOffscreenDocument();
    const request: OffscreenCopyRequest = { target: 'offscreen', type: 'tc/offscreen-copy', payload };
    const response: unknown = await chrome.runtime.sendMessage(request);
    return typeof response === 'object' && response !== null && (response as { ok?: unknown }).ok === true;
  } catch (error) {
    console.error('Table Copy: clipboard write failed', error);
    return false;
  }
}
