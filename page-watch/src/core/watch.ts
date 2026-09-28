import { evaluateChange } from './compare';
import { isTransient } from './errors';
import { collapseSpaces, MAX_SNAPSHOT_CHARS } from './normalize';
import { parseTarget } from './numbers';
import { nextCheckDelay } from './schedule';
import {
  isChangeMode,
  isErrorCode,
  isInterval,
  type Change,
  type CheckError,
  type DiffLine,
  type IntervalMinutes,
  type Snapshot,
  type Watch,
  type WatchDraft,
  type WatchError,
  type WatchPatch,
  type WatchStatus,
} from './types';
import { hostLabel, normalizeWatchUrl } from './url';

/** Changes kept per watch (the oldest are dropped). */
export const MAX_CHANGES = 10;
export const MAX_WATCHES = 100;
export const MAX_NAME_CHARS = 120;
export const MAX_KEYWORD_CHARS = 100;
export const MAX_TARGET_CHARS = 30;
export const MAX_SELECTOR_CHARS = 1000;
const MAX_SELECTOR_CANDIDATES = 6;
/** Transient errors are only notified once they happen this many times in a row. */
export const TRANSIENT_ERRORS_BEFORE_NOTIFY = 3;

export type CheckOutcome = { ok: true; text: string; truncated: boolean } | { ok: false; error: CheckError };

// --- Sanitizing what comes out of storage ----------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

const STATUSES: readonly WatchStatus[] = ['pending', 'unchanged', 'changed', 'error'];

function sanitizeError(raw: unknown): WatchError | null {
  if (!isRecord(raw) || !isErrorCode(raw.code)) return null;
  const error: WatchError = { code: raw.code, message: str(raw.message, 500), at: num(raw.at) ?? 0 };
  const status = num(raw.status);
  if (status !== null) error.status = status;
  const retryAfter = num(raw.retryAfterSeconds);
  if (retryAfter !== null) error.retryAfterSeconds = retryAfter;
  return error;
}

export function sanitizeWatch(raw: unknown): Watch | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const url = normalizeWatchUrl(raw.url);
  if (!url) return null;
  const selector = typeof raw.selector === 'string' && raw.selector.trim() ? raw.selector.slice(0, MAX_SELECTOR_CHARS) : null;
  const mode = isChangeMode(raw.mode) ? raw.mode : 'text';
  const keyword = str(raw.keyword, MAX_KEYWORD_CHARS);
  const target = str(raw.target, MAX_TARGET_CHARS);
  const paused = raw.paused === true;
  return {
    id: raw.id.slice(0, 64),
    url,
    name: str(raw.name, MAX_NAME_CHARS) || hostLabel(url),
    selector,
    intervalMinutes: isInterval(raw.intervalMinutes) ? raw.intervalMinutes : 60,
    // A keyword or price rule without its keyword or target can never fire; fall back to any change.
    mode: (mode === 'keyword' && !keyword.trim()) || (mode === 'below' && !parseTarget(target)) ? 'text' : mode,
    keyword,
    target,
    paused,
    createdAt: num(raw.createdAt) ?? 0,
    lastCheckedAt: num(raw.lastCheckedAt),
    lastChangedAt: num(raw.lastChangedAt),
    nextCheckAt: paused ? null : num(raw.nextCheckAt),
    status: STATUSES.includes(raw.status as WatchStatus) ? (raw.status as WatchStatus) : 'pending',
    error: sanitizeError(raw.error),
    errorCount: Math.max(0, Math.floor(num(raw.errorCount) ?? 0)),
    errorNotified: raw.errorNotified === true,
    unseen: Math.max(0, Math.min(MAX_CHANGES, Math.floor(num(raw.unseen) ?? 0))),
    lastSummary: typeof raw.lastSummary === 'string' ? raw.lastSummary.slice(0, 300) : null,
  };
}

export function sanitizeWatches(raw: unknown): Watch[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const watches: Watch[] = [];
  for (const item of raw) {
    const watch = sanitizeWatch(item);
    if (!watch || seen.has(watch.id)) continue;
    seen.add(watch.id);
    watches.push(watch);
  }
  return watches.slice(0, MAX_WATCHES);
}

const LINE_TYPES = new Set(['add', 'remove', 'context', 'skip']);

function sanitizeLines(raw: unknown): DiffLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: DiffLine[] = [];
  for (const item of raw.slice(0, 400)) {
    if (!isRecord(item) || !LINE_TYPES.has(item.type as string)) continue;
    const line: DiffLine = { type: item.type as DiffLine['type'], text: str(item.text, 1000) };
    const count = num(item.count);
    if (line.type === 'skip') line.count = Math.max(0, Math.floor(count ?? 0));
    lines.push(line);
  }
  return lines;
}

export function sanitizeChanges(raw: unknown): Change[] {
  if (!Array.isArray(raw)) return [];
  const changes: Change[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    changes.push({
      id: item.id.slice(0, 64),
      at: num(item.at) ?? 0,
      summary: str(item.summary, 300),
      added: Math.max(0, num(item.added) ?? 0),
      removed: Math.max(0, num(item.removed) ?? 0),
      lines: sanitizeLines(item.lines),
      truncated: item.truncated === true,
      seen: item.seen === true,
    });
  }
  return changes.slice(0, MAX_CHANGES);
}

export function sanitizeSnapshot(raw: unknown): Snapshot | null {
  if (!isRecord(raw) || typeof raw.text !== 'string') return null;
  return { text: raw.text.slice(0, MAX_SNAPSHOT_CHARS), at: num(raw.at) ?? 0, truncated: raw.truncated === true };
}

export function countUnseen(changes: readonly Change[]): number {
  return changes.filter((change) => !change.seen).length;
}

export function totalUnseen(watches: readonly Watch[]): number {
  return watches.reduce((sum, watch) => sum + watch.unseen, 0);
}

// --- Validating what the UI sends ------------------------------------------------------

export function cleanName(value: unknown): string {
  return typeof value === 'string' ? collapseSpaces(value).slice(0, MAX_NAME_CHARS) : '';
}

export function cleanKeyword(value: unknown): string {
  return typeof value === 'string' ? collapseSpaces(value).slice(0, MAX_KEYWORD_CHARS) : '';
}

export function cleanTarget(value: unknown): string {
  return typeof value === 'string' ? collapseSpaces(value).slice(0, MAX_TARGET_CHARS) : '';
}

export const TARGET_MESSAGE = 'Enter the price to watch for, for example 99.99 or $100.';

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

export function validateDraft(raw: unknown): Validated<WatchDraft> {
  if (!isRecord(raw)) return { ok: false, message: 'Missing watch details.' };
  const url = normalizeWatchUrl(raw.url);
  if (!url) return { ok: false, message: 'Only web pages (http or https) can be watched.' };
  if (!isInterval(raw.intervalMinutes)) return { ok: false, message: 'Choose how often to check.' };
  if (!isChangeMode(raw.mode)) return { ok: false, message: 'Choose what counts as a change.' };
  const keyword = cleanKeyword(raw.keyword);
  if (raw.mode === 'keyword' && !keyword) return { ok: false, message: 'Enter the keyword to look for.' };
  const target = cleanTarget(raw.target);
  if (raw.mode === 'below' && !parseTarget(target)) return { ok: false, message: TARGET_MESSAGE };
  const selectors = Array.isArray(raw.selectors)
    ? raw.selectors
        .filter((selector): selector is string => typeof selector === 'string')
        .map((selector) => selector.trim())
        .filter((selector) => selector.length > 0 && selector.length <= MAX_SELECTOR_CHARS)
        .slice(0, MAX_SELECTOR_CANDIDATES)
    : [];
  if (Array.isArray(raw.selectors) && raw.selectors.length > 0 && selectors.length === 0) {
    return { ok: false, message: "The picked element doesn't have a usable selector. Try a nearby element." };
  }
  return {
    ok: true,
    value: {
      url,
      name: cleanName(raw.name),
      selectors,
      intervalMinutes: raw.intervalMinutes,
      mode: raw.mode,
      keyword,
      target,
      liveText: typeof raw.liveText === 'string' ? raw.liveText.slice(0, MAX_SNAPSHOT_CHARS) : null,
    },
  };
}

export function validatePatch(raw: unknown): Validated<WatchPatch> {
  if (!isRecord(raw)) return { ok: false, message: 'Nothing to change.' };
  const patch: WatchPatch = {};
  if (raw.name !== undefined) {
    const name = cleanName(raw.name);
    if (!name) return { ok: false, message: 'Give the watch a name.' };
    patch.name = name;
  }
  if (raw.intervalMinutes !== undefined) {
    if (!isInterval(raw.intervalMinutes)) return { ok: false, message: 'Choose how often to check.' };
    patch.intervalMinutes = raw.intervalMinutes;
  }
  if (raw.mode !== undefined) {
    if (!isChangeMode(raw.mode)) return { ok: false, message: 'Choose what counts as a change.' };
    patch.mode = raw.mode;
  }
  if (raw.keyword !== undefined) patch.keyword = cleanKeyword(raw.keyword);
  if (raw.target !== undefined) patch.target = cleanTarget(raw.target);
  return { ok: true, value: patch };
}

// --- State transitions -----------------------------------------------------------------

export interface NewWatchInput {
  url: string;
  name: string;
  selector: string | null;
  intervalMinutes: IntervalMinutes;
  mode: Watch['mode'];
  keyword: string;
  target?: string;
}

export function createWatch(input: NewWatchInput, id: string, now: number): Watch {
  return {
    id,
    url: input.url,
    name: input.name || hostLabel(input.url),
    selector: input.selector,
    intervalMinutes: input.intervalMinutes,
    mode: input.mode,
    keyword: input.mode === 'keyword' ? input.keyword : '',
    target: input.mode === 'below' ? (input.target ?? '') : '',
    paused: false,
    createdAt: now,
    lastCheckedAt: null,
    lastChangedAt: null,
    nextCheckAt: null,
    status: 'pending',
    error: null,
    errorCount: 0,
    errorNotified: false,
    unseen: 0,
    lastSummary: null,
  };
}

export interface CheckContext {
  now: number;
  random: () => number;
  changeId: string;
}

export interface CheckApplied {
  watch: Watch;
  /** New baseline to store (only on success). */
  snapshot: Snapshot | null;
  changes: Change[];
  /** The change recorded by this check, if any. */
  change: Change | null;
  /** Show an error notification for this check. */
  notifyError: boolean;
}

/**
 * Applies a check result to a watch: records a change when the rule says so, moves the
 * baseline forward, tracks the error streak and schedules the next check (with backoff).
 */
export function applyCheck(
  watch: Watch,
  previous: Snapshot | null,
  changes: readonly Change[],
  outcome: CheckOutcome,
  context: CheckContext,
): CheckApplied {
  const { now, random } = context;
  const schedule = (errorCount: number, retryAfter?: number) =>
    watch.paused ? null : now + nextCheckDelay(watch.intervalMinutes, errorCount, random, retryAfter);

  if (!outcome.ok) {
    const errorCount = watch.errorCount + 1;
    const due = isTransient(outcome.error) ? errorCount >= TRANSIENT_ERRORS_BEFORE_NOTIFY : true;
    const notifyError = due && !watch.errorNotified;
    return {
      watch: {
        ...watch,
        lastCheckedAt: now,
        status: 'error',
        error: { ...outcome.error, at: now },
        errorCount,
        errorNotified: watch.errorNotified || notifyError,
        nextCheckAt: schedule(errorCount, outcome.error.retryAfterSeconds),
      },
      snapshot: null,
      changes: [...changes],
      change: null,
      notifyError,
    };
  }

  const snapshot: Snapshot = { text: outcome.text, at: now, truncated: outcome.truncated };
  const recovered: Watch = {
    ...watch,
    lastCheckedAt: now,
    error: null,
    errorCount: 0,
    errorNotified: false,
    nextCheckAt: schedule(0),
  };

  const evaluation = previous ? evaluateChange(previous.text, outcome.text, watch) : null;
  if (!evaluation?.changed) {
    return {
      watch: { ...recovered, status: 'unchanged' },
      snapshot,
      changes: [...changes],
      change: null,
      notifyError: false,
    };
  }

  const change: Change = {
    id: context.changeId,
    at: now,
    summary: evaluation.summary,
    added: evaluation.added,
    removed: evaluation.removed,
    lines: evaluation.lines,
    truncated: evaluation.truncated,
    seen: false,
  };
  const nextChanges = [change, ...changes].slice(0, MAX_CHANGES);
  return {
    watch: {
      ...recovered,
      status: 'changed',
      lastChangedAt: now,
      lastSummary: change.summary,
      unseen: countUnseen(nextChanges),
    },
    snapshot,
    changes: nextChanges,
    change,
    notifyError: false,
  };
}

/** Marks every change of a watch as seen. */
export function markSeen(watch: Watch, changes: readonly Change[]): { watch: Watch; changes: Change[] } {
  return { watch: { ...watch, unseen: 0 }, changes: changes.map((change) => (change.seen ? change : { ...change, seen: true })) };
}

/**
 * Applies user edits. The URL and selector can't change, so a check that is running meanwhile
 * stays valid: its text is evaluated with the new rule.
 */
export function applyPatch(watch: Watch, patch: WatchPatch, now: number, random: () => number): Watch {
  const next: Watch = { ...watch };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.keyword !== undefined) next.keyword = patch.keyword;
  if (patch.target !== undefined) next.target = patch.target;
  if (next.mode !== 'keyword') next.keyword = '';
  if (next.mode !== 'below') next.target = '';
  // A rule that could never fire (the UI prevents this; stay safe anyway).
  if (next.mode === 'keyword' && !next.keyword) next.mode = 'text';
  if (next.mode === 'below' && !parseTarget(next.target)) {
    next.mode = 'text';
    next.target = '';
  }
  if (patch.intervalMinutes !== undefined && patch.intervalMinutes !== watch.intervalMinutes) {
    next.intervalMinutes = patch.intervalMinutes;
    if (!next.paused) next.nextCheckAt = now + nextCheckDelay(next.intervalMinutes, 0, random);
  }
  return next;
}

/** Pausing drops the schedule; resuming schedules the next check (the caller also checks right away). */
export function setPaused(watch: Watch, paused: boolean, now: number, random: () => number): Watch {
  return { ...watch, paused, nextCheckAt: paused ? null : now + nextCheckDelay(watch.intervalMinutes, 0, random) };
}

/**
 * Popup order: watches with unseen changes first (newest change first), then the rest,
 * newest first.
 */
export function sortWatches(watches: readonly Watch[]): Watch[] {
  return [...watches].sort((a, b) => {
    if ((a.unseen > 0) !== (b.unseen > 0)) return a.unseen > 0 ? -1 : 1;
    if (a.unseen > 0) return (b.lastChangedAt ?? 0) - (a.lastChangedAt ?? 0);
    return b.createdAt - a.createdAt;
  });
}
