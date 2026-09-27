import { MAX_CAPTURE_CHARS } from '../core/limits';
import type { AnchorRect } from './messages';

export interface PageSelection {
  text: string;
  totalLength: number;
  title: string;
  url: string;
  anchor: AnchorRect | null;
}

/**
 * Runs inside the page via chrome.scripting.executeScript. It is serialized with
 * Function.prototype.toString, so it must stay self-contained: no imports, no outer
 * variables, only its arguments.
 *
 * Reads plain text only (never HTML), so nothing from the page is ever rendered as markup.
 */
export function readSelectionInPage(maxChars: number): PageSelection {
  let text = '';
  let anchor: AnchorRect | null = null;

  const toAnchor = (rect: DOMRect): AnchorRect | null =>
    rect.width > 0 || rect.height > 0 ? { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right } : null;

  // Selections inside <textarea>/<input> are not part of window.getSelection() text.
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    try {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (start !== null && end !== null && end > start) {
        text = active.value.slice(start, end);
        anchor = toAnchor(active.getBoundingClientRect());
      }
    } catch {
      // Input types without a selection API.
    }
  }

  const selection = window.getSelection();
  if (!text && selection && selection.rangeCount > 0) {
    text = selection.toString();
    const range = selection.getRangeAt(selection.rangeCount - 1);
    const rects = range.getClientRects();
    const last = rects.length > 0 ? rects[rects.length - 1] : undefined;
    anchor = last ? toAnchor(last) : toAnchor(range.getBoundingClientRect());
  }

  const totalLength = text.length;
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, totalLength, title: document.title, url: location.href, anchor };
}

/** Reads the selection of a frame. Returns null when the page can't be scripted. */
export async function captureSelection(tabId: number, frameId: number): Promise<PageSelection | null> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: readSelectionInPage,
      args: [MAX_CAPTURE_CHARS],
    });
    return (injection?.result as PageSelection | undefined) ?? null;
  } catch {
    // chrome://, the Web Store, the PDF viewer, cross-origin frames without access...
    return null;
  }
}
