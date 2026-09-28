import type { ClipboardPayload } from '../core/formats';

/**
 * Writing text/plain and text/html together. A `copy` event listener fills the clipboard
 * with both types, then document.execCommand('copy') fires it. Works in the offscreen
 * document (which never has focus, so the async Clipboard API is unavailable) and in the
 * popup. Returns false when the browser refused.
 */
export function copyWithEvent(payload: ClipboardPayload, doc: Document = document): boolean {
  let handled = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData('text/plain', payload.text);
    if (payload.html) event.clipboardData.setData('text/html', payload.html);
    handled = true;
  };
  doc.addEventListener('copy', onCopy, true);
  try {
    return doc.execCommand('copy') && handled;
  } catch {
    return false;
  } finally {
    doc.removeEventListener('copy', onCopy, true);
  }
}

/** Plain text only, through a selected textarea: the oldest and most compatible way. */
export function copyWithTextarea(text: string, doc: Document = document): boolean {
  const previousFocus = doc.activeElement;
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  doc.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = doc.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  return copied;
}

/** From a focused extension page (the popup): every method in turn. */
export async function copyFromPage(payload: ClipboardPayload): Promise<boolean> {
  if (copyWithEvent(payload)) return true;
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem === 'function') {
      const items: Record<string, Blob> = { 'text/plain': new Blob([payload.text], { type: 'text/plain' }) };
      if (payload.html) items['text/html'] = new Blob([payload.html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return true;
    }
  } catch {
    // Fall through.
  }
  return payload.html ? false : copyWithTextarea(payload.text);
}
