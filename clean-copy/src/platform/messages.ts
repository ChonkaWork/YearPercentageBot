/** Messages between the extension's own contexts. Only our own pages send them. */

export interface CopyRequest {
  /** Popup → background: clipboard fallback when the popup can't write itself. */
  type: 'cc/copy';
  text: string;
}

export interface SyncRequest {
  /** Popup/options → background: sites or permissions changed, update the registration now. */
  type: 'cc/sync-sites';
}

export type BackgroundRequest = CopyRequest | SyncRequest;

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'cc/copy') return typeof message.text === 'string';
  return message.type === 'cc/sync-sites';
}

export interface OffscreenCopyRequest {
  target: 'offscreen';
  type: 'cc/offscreen-copy';
  text: string;
}

export function isOffscreenCopyRequest(value: unknown): value is OffscreenCopyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.target === 'offscreen' && message.type === 'cc/offscreen-copy' && typeof message.text === 'string';
}
