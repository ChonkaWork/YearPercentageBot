/**
 * Writing plain text to the clipboard. Clean copies are only ever text/plain: no text/html
 * means no fonts, colors or links when you paste. The one exception is Undo, which puts the
 * page's original HTML back next to its text (`html`).
 *
 * A `copy` event listener sets the data, then document.execCommand('copy') fires it. Works
 * in the offscreen document (which never has focus, so the async Clipboard API is
 * unavailable) and in the popup. Returns false when the browser refused.
 */
export function copyWithEvent(text: string, doc: Document = document, html?: string): boolean {
  let handled = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.clearData();
    event.clipboardData.setData('text/plain', text);
    if (html) event.clipboardData.setData('text/html', html);
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

/**
 * Reads the clipboard's text (and HTML, when there is some) through a `paste` event fired by
 * document.execCommand('paste'). Needs the clipboardRead permission; works in the offscreen
 * document. Null when the browser refused (no permission).
 */
export function readWithPaste(doc: Document = document): { text: string; html: string } | null {
  let result: { text: string; html: string } | null = null;
  const onPaste = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    result = { text: event.clipboardData.getData('text/plain'), html: event.clipboardData.getData('text/html') };
  };
  const target = doc.createElement('textarea');
  target.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  doc.body.append(target);
  target.focus();
  doc.addEventListener('paste', onPaste, true);
  let accepted = false;
  try {
    accepted = doc.execCommand('paste');
  } catch {
    accepted = false;
  } finally {
    doc.removeEventListener('paste', onPaste, true);
    target.remove();
  }
  if (result) return result;
  return accepted ? { text: target.value, html: '' } : null;
}
