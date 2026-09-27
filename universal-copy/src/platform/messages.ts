import type { ClipboardPayload } from '../core/convert';

// --- Popup → background ------------------------------------------------------------------

/** Fallback when the popup can't write to the clipboard itself. */
export interface CopyRequest {
  type: 'uc/copy';
  payload: ClipboardPayload;
}

export type BackgroundRequest = CopyRequest;

export function isClipboardPayload(value: unknown): value is ClipboardPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.text === 'string' && (payload.html === undefined || typeof payload.html === 'string');
}

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.type === 'uc/copy' && isClipboardPayload(message.payload);
}

// --- Background → offscreen document -----------------------------------------------------

export interface OffscreenCopyRequest {
  target: 'offscreen';
  type: 'uc/offscreen-copy';
  payload: ClipboardPayload;
}

export function isOffscreenCopyRequest(value: unknown): value is OffscreenCopyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.target === 'offscreen' && message.type === 'uc/offscreen-copy' && isClipboardPayload(message.payload);
}
