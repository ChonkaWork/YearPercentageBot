/**
 * Offscreen document: its only job is writing text to the clipboard for the service
 * worker. execCommand('copy') is used because the async Clipboard API requires a focused
 * document, which an offscreen document never is.
 */

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isCopyRequest(message)) return false;
  sendResponse({ ok: copy(message.text) });
  return false;
});

function isCopyRequest(message: unknown): message is { text: string } {
  if (typeof message !== 'object' || message === null) return false;
  const request = message as Record<string, unknown>;
  return request.target === 'offscreen' && request.type === 'pastebot/offscreen-copy' && typeof request.text === 'string';
}

function copy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.append(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
