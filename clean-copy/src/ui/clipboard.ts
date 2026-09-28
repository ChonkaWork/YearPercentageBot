/**
 * Writing plain text to the clipboard. Clean Copy only ever writes text/plain: no
 * text/html means no fonts, colors or links when you paste.
 *
 * A `copy` event listener sets the data, then document.execCommand('copy') fires it. Works
 * in the offscreen document (which never has focus, so the async Clipboard API is
 * unavailable) and in the popup. Returns false when the browser refused.
 */
export function copyWithEvent(text: string, doc: Document = document): boolean {
  let handled = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.clearData();
    event.clipboardData.setData('text/plain', text);
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

/** Through a selected textarea: the oldest and most compatible way. */
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
export async function copyFromPage(text: string): Promise<boolean> {
  if (copyWithEvent(text)) return true;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through.
  }
  return copyWithTextarea(text);
}
