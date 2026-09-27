/**
 * Copies from a focused extension page (the popup). Tries the async Clipboard API first,
 * then execCommand('copy').
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // No focus or permission policy: fall through.
  }
  return copyWithExecCommand(text);
}

function copyWithExecCommand(text: string): boolean {
  const previousFocus = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
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
