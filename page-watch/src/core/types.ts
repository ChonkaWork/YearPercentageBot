/** Check intervals offered in the UI, in minutes. */
export const INTERVALS = [5, 15, 30, 60, 360, 1440] as const;
export type IntervalMinutes = (typeof INTERVALS)[number];

export function isInterval(value: unknown): value is IntervalMinutes {
  return typeof value === 'number' && (INTERVALS as readonly number[]).includes(value);
}

/**
 * What counts as a change:
 * - text: any change in the watched text
 * - number: only when a number or price in the region changes
 * - keyword: only when a keyword appears or disappears
 * - below: only when the price drops below a target
 */
export const CHANGE_MODES = ['text', 'number', 'keyword', 'below'] as const;
export type ChangeMode = (typeof CHANGE_MODES)[number];

export function isChangeMode(value: unknown): value is ChangeMode {
  return typeof value === 'string' && (CHANGE_MODES as readonly string[]).includes(value);
}

export const ERROR_CODES = [
  'offline',
  'network',
  'timeout',
  'http',
  'not-html',
  'too-large',
  'permission',
  'selector',
  'js-rendered',
  'empty',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export interface CheckError {
  code: ErrorCode;
  message: string;
  /** HTTP status for `http` errors. */
  status?: number;
  /** From a Retry-After header (429/503). */
  retryAfterSeconds?: number;
}

export interface WatchError extends CheckError {
  at: number;
}

/** Latest result of a watch, shown in the popup. */
export type WatchStatus = 'pending' | 'unchanged' | 'changed' | 'error';

export interface Watch {
  id: string;
  url: string;
  name: string;
  /** CSS selector of the watched element, or null for the whole page. */
  selector: string | null;
  intervalMinutes: IntervalMinutes;
  mode: ChangeMode;
  /** Only used in keyword mode. */
  keyword: string;
  /** Only used in `below` mode: the target price as the user typed it ("99.99", "$100", "1 500 грн"). */
  target: string;
  paused: boolean;
  createdAt: number;
  lastCheckedAt: number | null;
  lastChangedAt: number | null;
  /** When the next scheduled check is due. Null while paused. */
  nextCheckAt: number | null;
  status: WatchStatus;
  error: WatchError | null;
  /** Consecutive failed checks, drives the backoff. */
  errorCount: number;
  /** A notification about the current error episode was already shown. */
  errorNotified: boolean;
  /** Changes not looked at yet (feeds the toolbar badge). */
  unseen: number;
  /** Summary of the most recent change. */
  lastSummary: string | null;
}

export type DiffLineType = 'add' | 'remove' | 'context' | 'skip';

export interface DiffLine {
  type: DiffLineType;
  /** Line text; empty for `skip`. */
  text: string;
  /** Number of folded unchanged lines for `skip`. */
  count?: number;
}

export interface Change {
  id: string;
  at: number;
  summary: string;
  added: number;
  removed: number;
  /** Changed lines with a little context, folded and capped to bound storage. */
  lines: DiffLine[];
  /** Some diff lines were left out because the diff was too large. */
  truncated: boolean;
  seen: boolean;
}

export interface Snapshot {
  text: string;
  at: number;
  truncated: boolean;
}

/** What the user chose when adding a watch (from the popup or the element picker). */
export interface WatchDraft {
  url: string;
  name: string;
  /** Candidate selectors, most robust first, all verified unique on the live page. Empty for the whole page. */
  selectors: string[];
  intervalMinutes: IntervalMinutes;
  mode: ChangeMode;
  keyword: string;
  target: string;
  /** Text of the region (or page) as it looked in the live tab, for JavaScript-rendering detection. */
  liveText: string | null;
}

/** Fields the user can edit after creation. */
export interface WatchPatch {
  name?: string;
  intervalMinutes?: IntervalMinutes;
  mode?: ChangeMode;
  keyword?: string;
  target?: string;
}
