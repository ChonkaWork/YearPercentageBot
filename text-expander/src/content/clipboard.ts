/**
 * Reads the clipboard for `{clipboard}` at the moment a snippet expands.
 *
 * With the optional `clipboardRead` permission, Chrome lets an extension's content script run
 * `document.execCommand('paste')`. That fires a `paste` event carrying the clipboard text at the
 * focused field; we take the text and cancel the event, so nothing is pasted, focus and the
 * caret stay where they are, and the page's own handlers (on the field, the document or the
 * window after us) never see it. Unlike `navigator.clipboard.readText()` it is synchronous and
 * isn't blocked by a page's Permissions-Policy or in cross-origin iframes. Without the
 * permission the command does nothing and `{clipboard}` inserts nothing.
 */
export function readClipboardText(): string {
  let text: string | null = null;
  const onPaste = (event: ClipboardEvent) => {
    text = event.clipboardData?.getData('text/plain') ?? '';
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('paste', onPaste, true);
  try {
    document.execCommand('paste');
  } catch {
    // Not allowed: nothing to insert.
  } finally {
    window.removeEventListener('paste', onPaste, true);
  }
  return text ?? '';
}
