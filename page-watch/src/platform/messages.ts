import type { CandidateResult, ExtractedText } from '../core/creation';
import { sanitizePlan, type Plan } from '../core/plan';
import type { ErrorCode, IntervalMinutes, Watch, WatchDraft } from '../core/types';

/**
 * Messages between the extension's contexts. The service worker is the only writer of watch
 * data; the popup and the picker ask it to make changes.
 */

// --- Popup / picker → service worker ---------------------------------------------------

/** A watch being added, remembered across the permission prompt (which can close the popup). */
export interface PendingAdd {
  id: string;
  kind: 'page' | 'pick';
  tabId: number;
  url: string;
  /** For `page`: everything needed to create the watch. */
  draft?: WatchDraft;
  createdAt: number;
}

export type BackgroundRequest =
  | { type: 'pw/complete-add'; pending: PendingAdd }
  | { type: 'pw/create'; draft: WatchDraft }
  | { type: 'pw/check-now'; id: string }
  | { type: 'pw/update'; id: string; patch: unknown }
  | { type: 'pw/set-paused'; id: string; paused: boolean }
  | { type: 'pw/delete'; id: string }
  | { type: 'pw/mark-seen'; id: string | null }
  | { type: 'pw/access-granted'; url: string }
  | { type: 'pw/picker-closed'; url: string; created: boolean }
  | { type: 'pw/open-about-pro' };

const BACKGROUND_TYPES = new Set([
  'pw/complete-add',
  'pw/create',
  'pw/check-now',
  'pw/update',
  'pw/set-paused',
  'pw/delete',
  'pw/mark-seen',
  'pw/access-granted',
  'pw/picker-closed',
  'pw/open-about-pro',
]);

/** Requests a content script may send; everything else must come from an extension page. */
export const CONTENT_SCRIPT_TYPES = new Set(['pw/create', 'pw/picker-closed', 'pw/open-about-pro']);

export function isBackgroundRequest(message: unknown): message is BackgroundRequest {
  if (typeof message !== 'object' || message === null) return false;
  const request = message as Record<string, unknown>;
  if (typeof request.type !== 'string' || !BACKGROUND_TYPES.has(request.type)) return false;
  switch (request.type) {
    case 'pw/check-now':
    case 'pw/delete':
      return typeof request.id === 'string';
    case 'pw/update':
      return typeof request.id === 'string' && typeof request.patch === 'object' && request.patch !== null;
    case 'pw/set-paused':
      return typeof request.id === 'string' && typeof request.paused === 'boolean';
    case 'pw/mark-seen':
      return typeof request.id === 'string' || request.id === null;
    case 'pw/access-granted':
      return typeof request.url === 'string';
    case 'pw/picker-closed':
      return typeof request.url === 'string' && typeof request.created === 'boolean';
    case 'pw/create':
      return typeof request.draft === 'object' && request.draft !== null;
    case 'pw/complete-add':
      return isPendingAdd(request.pending);
    case 'pw/open-about-pro':
      return true;
    default:
      return false;
  }
}

export function isPendingAdd(value: unknown): value is PendingAdd {
  if (typeof value !== 'object' || value === null) return false;
  const pending = value as Record<string, unknown>;
  return (
    typeof pending.id === 'string' &&
    (pending.kind === 'page' || pending.kind === 'pick') &&
    typeof pending.tabId === 'number' &&
    typeof pending.url === 'string' &&
    typeof pending.createdAt === 'number'
  );
}

export type Failure = { ok: false; code: ErrorCode | 'invalid' | 'limit' | 'unavailable'; message: string };

/** `note`: something worth knowing about the new watch ("The price is already below $100: $89.00."). */
export type CreateResponse = { ok: true; watch: Watch; note?: string } | Failure;
export type SimpleResponse = { ok: true } | Failure;
/** `complete-add` either created a watch (page) or opened the picker (pick). */
export type CompleteAddResponse = { ok: true; watch?: Watch; note?: string; picker?: true } | Failure;

// --- Service worker → offscreen document ------------------------------------------------

export interface ExtractRequest {
  target: 'offscreen';
  type: 'pw/extract';
  html: string;
  /** Candidate selectors to try, or null for the whole page. */
  selectors: string[] | null;
}

export type ExtractResponse =
  | { ok: true; title: string; page: ExtractedText | null; results: CandidateResult[] }
  | { ok: false; message: string };

export function isExtractRequest(message: unknown): message is ExtractRequest {
  if (typeof message !== 'object' || message === null) return false;
  const request = message as Record<string, unknown>;
  return (
    request.target === 'offscreen' &&
    request.type === 'pw/extract' &&
    typeof request.html === 'string' &&
    (request.selectors === null || (Array.isArray(request.selectors) && request.selectors.every((s) => typeof s === 'string')))
  );
}

// --- Service worker → picker (content script) -------------------------------------------

export interface PickerStartMessage {
  type: 'pw/picker-start';
  title: string;
  intervalMinutes: IntervalMinutes;
  plan: Plan;
  /** e2e builds only: early access as the service worker sees it. */
  earlyAccess?: boolean;
}

export function isPickerStartMessage(message: unknown): message is PickerStartMessage {
  if (typeof message !== 'object' || message === null) return false;
  const request = message as Record<string, unknown>;
  if (request.type !== 'pw/picker-start' || typeof request.title !== 'string' || typeof request.intervalMinutes !== 'number') return false;
  request.plan = sanitizePlan(request.plan);
  return true;
}
