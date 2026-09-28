import { sanitizeSegments, type Segment } from './changes';

/**
 * The last clean copy, kept so it can be undone ("Undo" in the page, "Restore original" in
 * the popup) and inspected ("Show changes"). Lives in chrome.storage.session: memory only,
 * the last copy only, gone when the browser closes. Pure: no DOM, no Chrome APIs.
 */

export type CopyVia = 'shortcut' | 'menu' | 'popup' | 'auto' | 'clipboard';

/** What a normal copy would have put on the clipboard: plain text and, from a page, its HTML. */
export interface Original {
  text: string;
  html?: string;
}

export interface LastCopy {
  id: string;
  /** Date.now() of the copy. */
  at: number;
  via: CopyVia;
  /** Host name of the page (absent for the clipboard and pages without one). */
  host?: string;
  /** Restored by Undo. Null when the original was too large to keep. */
  original: Original | null;
  /** The clean text that went on the clipboard ('' when too large to keep). */
  cleaned: string;
  /** Length of the clean text. */
  length: number;
  /** describeClean() of the copy. */
  summary: string;
  /** Annotated text for "Show changes" (absent when too large or not tracked). */
  changes?: Segment[];
  /** Set after the original was put back on the clipboard. */
  restoredAt?: number;
}

export const LAST_COPY_LIMITS = {
  /** Characters of original text; a larger original can't be restored (it would be cut). */
  maxOriginalText: 500_000,
  /** Characters of original HTML; a larger one is dropped and Undo restores the text only. */
  maxOriginalHtml: 1_000_000,
  maxCleaned: 500_000,
  /** Characters in the annotated text. */
  maxChanges: 200_000,
} as const;

const VIA: readonly CopyVia[] = ['shortcut', 'menu', 'popup', 'auto', 'clipboard'];

export function newCopyId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface CopyInput {
  id?: string;
  at?: number;
  via: CopyVia;
  host?: string | null;
  original: Original | null;
  cleaned: string;
  summary: string;
  changes?: Segment[] | null;
}

/** Applies the size limits: what can't be kept whole is left out, never cut. */
export function prepareLastCopy(input: CopyInput): LastCopy {
  let original: Original | null = null;
  if (input.original && input.original.text.length <= LAST_COPY_LIMITS.maxOriginalText) {
    original = { text: input.original.text };
    if (input.original.html && input.original.html.length <= LAST_COPY_LIMITS.maxOriginalHtml) original.html = input.original.html;
  }
  const copy: LastCopy = {
    id: input.id ?? newCopyId(),
    at: input.at ?? Date.now(),
    via: input.via,
    original,
    cleaned: input.cleaned.length <= LAST_COPY_LIMITS.maxCleaned ? input.cleaned : '',
    length: input.cleaned.length,
    summary: input.summary,
  };
  if (input.host) copy.host = input.host;
  const size = input.changes?.reduce((sum, segment) => sum + segment.text.length, 0) ?? Infinity;
  if (input.changes && size <= LAST_COPY_LIMITS.maxChanges) copy.changes = input.changes;
  return copy;
}

/** Accepts anything read from storage (or sent by a content script); null when unusable. */
export function sanitizeLastCopy(raw: unknown): LastCopy | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !/^[\w-]{1,40}$/.test(value.id)) return null;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  if (typeof value.via !== 'string' || !VIA.includes(value.via as CopyVia)) return null;
  if (typeof value.cleaned !== 'string' || typeof value.summary !== 'string') return null;
  const original = sanitizeOriginal(value.original);
  const copy = prepareLastCopy({
    id: value.id,
    at: value.at,
    via: value.via as CopyVia,
    host: typeof value.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(value.host) ? value.host : null,
    original,
    cleaned: value.cleaned,
    summary: value.summary.slice(0, 300),
    changes: sanitizeSegments(value.changes, LAST_COPY_LIMITS.maxChanges),
  });
  if (typeof value.length === 'number' && Number.isInteger(value.length) && value.length >= copy.cleaned.length) copy.length = value.length;
  if (typeof value.restoredAt === 'number' && Number.isFinite(value.restoredAt)) copy.restoredAt = value.restoredAt;
  return copy;
}

function sanitizeOriginal(raw: unknown): Original | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.text !== 'string') return null;
  const original: Original = { text: value.text };
  if (typeof value.html === 'string' && value.html) original.html = value.html;
  return original;
}

// --- Display ----------------------------------------------------------------------------------

export function viaLabel(via: CopyVia): string {
  return {
    shortcut: 'Keyboard shortcut',
    menu: 'Right-click menu',
    popup: 'Toolbar popup',
    auto: 'Auto-clean on Ctrl+C',
    clipboard: 'Clean clipboard',
  }[via];
}

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function timeAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
