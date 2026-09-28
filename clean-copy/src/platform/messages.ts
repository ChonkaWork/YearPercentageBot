import { sanitizeLastCopy, type LastCopy } from '../core/lastCopy';

/** Messages between the extension's own contexts. Only our own pages and scripts send them. */

export interface CopyRequest {
  /** Popup → background: clipboard fallback when the popup can't write itself. */
  type: 'cc/copy';
  text: string;
}

export interface SyncRequest {
  /** Popup/options → background: sites or permissions changed, update the registration now. */
  type: 'cc/sync-sites';
}

export interface RecordCopyRequest {
  /** Auto-clean content script → background: keep this copy for Undo and "Show changes". */
  type: 'cc/record-copy';
  copy: LastCopy;
}

export interface UndoRequest {
  /** Toast (in the page) or popup → background: put the original of copy `id` back. */
  type: 'cc/undo';
  id?: string;
}

export interface CleanClipboardRequest {
  /** Popup → background: clean the text on the clipboard. `afterGrant`: right after the permission prompt. */
  type: 'cc/clean-clipboard';
  afterGrant?: boolean;
}

export type BackgroundRequest = CopyRequest | SyncRequest | RecordCopyRequest | UndoRequest | CleanClipboardRequest;

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'cc/copy':
      return typeof message.text === 'string';
    case 'cc/sync-sites':
      return true;
    case 'cc/record-copy':
      return sanitizeLastCopy(message.copy) !== null;
    case 'cc/undo':
      return message.id === undefined || typeof message.id === 'string';
    case 'cc/clean-clipboard':
      return message.afterGrant === undefined || typeof message.afterGrant === 'boolean';
    default:
      return false;
  }
}

/** Messages only the extension's own pages (popup, options) may send, not content scripts. */
export function isPageOnlyRequest(message: BackgroundRequest): boolean {
  return message.type === 'cc/copy' || message.type === 'cc/sync-sites' || message.type === 'cc/clean-clipboard';
}

export interface UndoResponse {
  ok: boolean;
  /** The original went back with its formatting (HTML), not just as text. */
  withHtml?: boolean;
  /** Why it failed: a newer copy replaced this one, nothing is kept, or the clipboard refused. */
  reason?: 'stale' | 'missing' | 'too-large' | 'clipboard';
}

export type ClipboardOutcome =
  | { status: 'cleaned'; id: string; summary: string; length: number }
  | { status: 'unchanged' }
  | { status: 'empty' }
  | { status: 'needs-permission' }
  | { status: 'error'; message: string };

export interface OffscreenCopyRequest {
  target: 'offscreen';
  type: 'cc/offscreen-copy';
  text: string;
  /** Also put this HTML on the clipboard (restoring an original). */
  html?: string;
}

export interface OffscreenPasteRequest {
  target: 'offscreen';
  type: 'cc/offscreen-paste';
}

export type OffscreenRequest = OffscreenCopyRequest | OffscreenPasteRequest;

export interface OffscreenPasteResponse {
  ok: boolean;
  text?: string;
  html?: string;
}

export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.target !== 'offscreen') return false;
  if (message.type === 'cc/offscreen-paste') return true;
  return message.type === 'cc/offscreen-copy' && typeof message.text === 'string' && (message.html === undefined || typeof message.html === 'string');
}
