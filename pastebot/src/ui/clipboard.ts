/**
 * Copies from a document the user is interacting with (popup, or the page after a click
 * in the Pastebot panel). Tries the async Clipboard API first, then execCommand.
 * `container` lets the fallback textarea live inside a shadow root.
 */
export async function copyFromDocument(text: string, container: ParentNode = document.body): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission policy, no focus, ... fall through.
  }
  return copyWithExecCommand(text, container);
}

function copyWithExecCommand(text: string, container: ParentNode): boolean {
  const previousFocus = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  container.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  return copied;
}
