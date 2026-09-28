/**
 * "Show changes": every cleanup step reports what it changed as edits (it knows what it
 * removed and why), and the edits of all steps are composed into one annotated text: the
 * text that stayed, what was removed and what was added, each with the step that did it.
 *
 * No character diff is involved: the cleaned text is the concatenation of the kept and added
 * runs, the text before cleanup the concatenation of the kept and removed runs.
 * Pure: no DOM, no Chrome APIs.
 */

export type ChangeKind =
  /** Zero-width spaces, BOMs, soft hyphens and similar characters. */
  | 'invisible'
  /** Collapsed spaces, trailing spaces, extra blank lines. */
  | 'whitespace'
  /** Line breaks merged into flowing paragraphs. */
  | 'line-break'
  /** List bullets removed. */
  | 'bullet'
  /** Tracking parameters removed from web addresses. */
  | 'tracking'
  /** Curly quotes, dashes, ellipses and special spaces made plain. */
  | 'typography'
  /** Markdown syntax removed. */
  | 'markdown'
  /** A custom rule's replacement. */
  | 'rule';

export const CHANGE_KINDS: readonly ChangeKind[] = ['invisible', 'whitespace', 'line-break', 'bullet', 'tracking', 'typography', 'markdown', 'rule'];

/** Replaces `text[start, end)` of a step's input with `insert` (nothing when absent). */
export interface Edit {
  start: number;
  end: number;
  insert?: string;
  kind: ChangeKind;
}

/** A run of the annotated text: unchanged (no `op`), removed (`del`) or added (`ins`). */
export interface Segment {
  text: string;
  op?: 'del' | 'ins';
  kind?: ChangeKind;
}

/** What a step returns: its output, and the edits that turn its input into that output. */
export interface StepResult {
  text: string;
  edits: Edit[];
}

export function segmentsOf(text: string): Segment[] {
  return text ? [{ text }] : [];
}

/** The cleaned text: what stayed and what was added. */
export function resultText(segments: readonly Segment[]): string {
  let out = '';
  for (const segment of segments) if (segment.op !== 'del') out += segment.text;
  return out;
}

/** The text before cleanup: what stayed and what was removed. */
export function sourceText(segments: readonly Segment[]): string {
  let out = '';
  for (const segment of segments) if (segment.op !== 'ins') out += segment.text;
  return out;
}

export function hasChanges(segments: readonly Segment[]): boolean {
  return segments.some((segment) => segment.op !== undefined);
}

/** Applies edits to plain text. Edits are sorted and clipped so they never overlap. */
export function applyEditsToText(text: string, edits: readonly Edit[]): string {
  let out = '';
  let last = 0;
  for (const edit of normalizeEdits(edits, text.length)) {
    out += text.slice(last, edit.start) + (edit.insert ?? '');
    last = edit.end;
  }
  return out + text.slice(last);
}

/**
 * Sorted by position, clipped to the text, without overlaps (a later edit that overlaps an
 * earlier one starts where the earlier one ends) and without edits that change nothing.
 */
export function normalizeEdits(edits: readonly Edit[], length: number): Edit[] {
  const sorted = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => a.edit.start - b.edit.start || a.edit.end - b.edit.end || a.index - b.index)
    .map(({ edit }) => edit);
  const out: Edit[] = [];
  let floor = 0;
  for (const edit of sorted) {
    const start = Math.min(Math.max(edit.start, floor), length);
    const end = Math.min(Math.max(edit.end, start), length);
    if (start === end && !edit.insert) continue;
    out.push(edit.insert ? { start, end, insert: edit.insert, kind: edit.kind } : { start, end, kind: edit.kind });
    floor = end;
  }
  return out;
}

/**
 * Applies one step's edits (in the coordinates of the current cleaned text) to the annotated
 * text. Kept text inside an edit becomes removed; text an earlier step added and this one
 * removes disappears (it never was in the source); the replacement is added after what it
 * replaces.
 */
export function applyEdits(segments: readonly Segment[], edits: readonly Edit[]): Segment[] {
  const list = normalizeEdits(edits, resultText(segments).length);
  if (list.length === 0) return segments.slice();
  const out: Segment[] = [];
  let index = 0;
  let pos = 0;

  const flushAt = (at: number) => {
    // Pure insertions (and ends of edits) that sit exactly at `at`.
    for (let edit = list[index]; edit && edit.start === at && edit.end === at; edit = list[index]) {
      if (edit.insert) push(out, { text: edit.insert, op: 'ins', kind: edit.kind });
      index++;
    }
  };

  for (const segment of segments) {
    if (segment.op === 'del') {
      push(out, segment);
      continue;
    }
    const length = segment.text.length;
    let offset = 0;
    while (offset < length) {
      const at = pos + offset;
      flushAt(at);
      const edit = list[index];
      if (!edit || edit.start >= pos + length) {
        push(out, piece(segment, offset, length));
        offset = length;
        break;
      }
      if (edit.start > at) {
        push(out, piece(segment, offset, edit.start - pos));
        offset = edit.start - pos;
        continue;
      }
      // Inside the edit's range.
      const stop = Math.min(edit.end - pos, length);
      if (segment.op !== 'ins') push(out, { text: segment.text.slice(offset, stop), op: 'del', kind: edit.kind });
      offset = stop;
      if (edit.end <= pos + offset) {
        if (edit.insert) push(out, { text: edit.insert, op: 'ins', kind: edit.kind });
        index++;
      }
    }
    pos += length;
  }
  // Insertions at the very end, and edits that ended exactly at the end.
  for (; index < list.length; index++) {
    const edit = list[index];
    if (edit?.insert) push(out, { text: edit.insert, op: 'ins', kind: edit.kind });
  }
  return out;
}

function piece(segment: Segment, from: number, to: number): Segment {
  const text = segment.text.slice(from, to);
  return segment.op ? { text, op: segment.op, kind: segment.kind } : { text };
}

/** Appends a run, merging it into the previous one when both are the same kind of run. */
function push(out: Segment[], segment: Segment): void {
  if (!segment.text) return;
  const last = out[out.length - 1];
  if (last && last.op === segment.op && last.kind === segment.kind) {
    last.text += segment.text;
    return;
  }
  out.push({ ...segment });
}

/** Deletions from a per-character mask (1 = removed), as edits. */
export function maskToEdits(removed: Uint8Array, kind: ChangeKind): Edit[] {
  const edits: Edit[] = [];
  for (let i = 0; i < removed.length; i++) {
    if (!removed[i]) continue;
    const start = i;
    while (i < removed.length && removed[i]) i++;
    edits.push({ start, end: i, kind });
  }
  return edits;
}

/**
 * One replacement at `start` (`before` → `after`), reduced to the part that really changes:
 * " — " → " - " only replaces the dash. Null when nothing changes.
 */
export function replacementEdit(start: number, before: string, after: string, kind: ChangeKind): Edit | null {
  if (before === after) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const insert = after.slice(prefix, after.length - suffix);
  const edit: Edit = { start: start + prefix, end: start + before.length - suffix, kind };
  if (insert) edit.insert = insert;
  return edit;
}

/**
 * Safety net for a step whose edits don't reproduce its output (a bug, or a character case
 * a step didn't foresee): one replacement between the common prefix and suffix. The cleaned
 * text never depends on edits, only the "Show changes" view does.
 */
export function fallbackEdits(before: string, after: string, kind: ChangeKind): Edit[] {
  const edit = replacementEdit(0, before, after, kind);
  return edit ? [edit] : [];
}

/**
 * Follows a text through the cleanup steps. Disabled (null segments) for very large texts:
 * the cleanup itself is unaffected, only "Show changes" is unavailable.
 */
export interface Tracker {
  text: string;
  segments: Segment[] | null;
}

export function startTracking(text: string, enabled: boolean): Tracker {
  return { text, segments: enabled ? segmentsOf(text) : null };
}

export function track(tracker: Tracker, step: StepResult, kind: ChangeKind): Tracker {
  if (!tracker.segments) return { text: step.text, segments: null };
  let segments = applyEdits(tracker.segments, step.edits);
  if (resultText(segments) !== step.text) segments = applyEdits(tracker.segments, fallbackEdits(tracker.text, step.text, kind));
  return { text: step.text, segments };
}

/** Which kinds of change the annotated text contains, in display order. */
export function changeKinds(segments: readonly Segment[]): ChangeKind[] {
  const present = new Set(segments.map((segment) => segment.kind).filter((kind): kind is ChangeKind => kind !== undefined));
  return CHANGE_KINDS.filter((kind) => present.has(kind));
}

/**
 * The first `maxChars` characters of the annotated text (removed and added runs count), for
 * display. `truncated` says whether anything was cut.
 */
export function limitSegments(segments: readonly Segment[], maxChars: number): { segments: Segment[]; truncated: boolean } {
  const out: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    if (used >= maxChars) return { segments: out, truncated: true };
    const room = maxChars - used;
    if (segment.text.length > room) {
      out.push({ ...segment, text: segment.text.slice(0, room) });
      return { segments: out, truncated: true };
    }
    out.push(segment);
    used += segment.text.length;
  }
  return { segments: out, truncated: false };
}

// --- Invisible characters -------------------------------------------------------------------

const INVISIBLE_NAMES: Record<string, { short: string; name: string }> = {
  '\u200B': { short: 'ZWSP', name: 'zero-width space' },
  '\u2060': { short: 'WJ', name: 'word joiner' },
  '\uFEFF': { short: 'BOM', name: 'byte order mark' },
  '\u00AD': { short: 'SHY', name: 'soft hyphen' },
  '\u180E': { short: 'MVS', name: 'Mongolian vowel separator' },
};

/** A short label for a removed invisible character ("ZWSP") and its name for tooltips. */
export function invisibleName(char: string): { short: string; name: string } {
  return INVISIBLE_NAMES[char] ?? { short: 'INV', name: 'invisible character' };
}

// --- Stored form ----------------------------------------------------------------------------

const KIND_SET = new Set<string>(CHANGE_KINDS);

/** Accepts anything read from storage; drops malformed runs. */
export function sanitizeSegments(raw: unknown, maxChars = Infinity): Segment[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Segment[] = [];
  let used = 0;
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const value = item as Record<string, unknown>;
    if (typeof value.text !== 'string') return null;
    used += value.text.length;
    if (used > maxChars) return null;
    const segment: Segment = { text: value.text };
    if (value.op === 'del' || value.op === 'ins') {
      segment.op = value.op;
      segment.kind = typeof value.kind === 'string' && KIND_SET.has(value.kind) ? (value.kind as ChangeKind) : 'rule';
    }
    out.push(segment);
  }
  return out;
}
