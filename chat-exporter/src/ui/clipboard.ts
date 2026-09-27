/**
 * Copies from a document the user is interacting with (popup, or the page right after a click
 * on the in-page button). Tries the async Clipboard API first, then execCommand.
 * `container` lets the fallback textarea live inside a shadow root.
 */
export async function copyText(text: string, container: ParentNode = document.body): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission policy, no focus, ... fall through to the legacy path.
  }
  return copyWithExecCommand(text, container);
}

function copyWithExecCommand(text: string, container: ParentNode): boolean {
  const previousFocus = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
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
