import { applyEditsToText, maskToEdits, type Edit, type StepResult } from './changes';

/**
 * The text steps of the Clean Copy pipeline. Each one returns its output and the edits that
 * produce it, so "Show changes" can say exactly what was removed and why.
 * Pure: no DOM, no Chrome APIs.
 */

/** Same set as removeInvisible in text.ts: zero-width space, word joiner, BOM, soft hyphen, MVS, invisible operators. */
const INVISIBLE_CHARS = /[\u200B\u2060\uFEFF\u00AD\u180E\u2061-\u2064]+/g;

/** Removes invisible junk characters. */
export function invisibleStep(text: string): StepResult {
  const edits: Edit[] = [];
  const out = text.replace(INVISIBLE_CHARS, (match: string, offset: number) => {
    edits.push({ start: offset, end: offset + match.length, kind: 'invisible' });
    return '';
  });
  return { text: out, edits };
}

/** Removes spaces and tabs at the end of every line (plain text as it arrives). */
export function trailingSpaceStep(text: string): StepResult {
  const removed = new Uint8Array(text.length);
  forEachLine(text, (start, end) => {
    for (let i = end - 1; i >= start && (text[i] === ' ' || text[i] === '\t'); i--) removed[i] = 1;
  });
  return withMask(text, removed, 'whitespace');
}

/**
 * tidyText as a step: no trailing spaces (tabs are kept, they are empty table cells), at most
 * one blank line in a row, no blank lines at the edges. Expects LF line endings.
 */
export function tidyStep(text: string): StepResult {
  const removed = new Uint8Array(text.length);
  forEachLine(text, (start, end) => {
    for (let i = end - 1; i >= start && text[i] === ' '; i--) removed[i] = 1;
  });
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (removed[i]) continue;
    if (text[i] === '\n') {
      run++;
      if (run > 2) removed[i] = 1;
    } else {
      run = 0;
    }
  }
  for (let i = 0; i < text.length && (removed[i] || text[i] === '\n'); i++) removed[i] = 1;
  for (let i = text.length - 1; i >= 0 && (removed[i] || text[i] === '\n'); i--) removed[i] = 1;
  return withMask(text, removed, 'whitespace');
}

/**
 * Runs of spaces inside a line become one space and trailing spaces go. Indentation at the
 * start of a line (nested lists, code) and tabs (they separate table cells) are kept; spaces
 * next to a tab go. Lines holding only whitespace become empty.
 */
export function collapseSpacesStep(text: string): StepResult {
  const removed = new Uint8Array(text.length);
  forEachLine(text, (start, end) => {
    const line = text.slice(start, end);
    if (!line.trim()) {
      removed.fill(1, start, end);
      return;
    }
    const body = start + (/^[ \t]*/.exec(line)?.[0].length ?? 0);
    let stop = end;
    while (stop > body && /\s/.test(text[stop - 1] ?? '')) stop--;
    removed.fill(1, stop, end);
    for (let i = body; i < stop; i++) {
      if (text[i] !== ' ') continue;
      let j = i;
      while (j < stop && text[j] === ' ') j++;
      if (text[i - 1] === '\t' || text[j] === '\t') removed.fill(1, i, j);
      else if (j - i >= 2) removed.fill(1, i + 1, j);
      i = j - 1;
    }
  });
  return withMask(text, removed, 'whitespace');
}

/** A list line: "- item", "• item", "* item", "1. item", "2) item", with any indentation. */
const LIST_LINE = /^[ \t]*(?:[-*•◦▪‣–·]|\d{1,3}[.)])[ \t]+\S/;
const BULLET = /^[ \t]*[-*•◦▪‣–·][ \t]+/;
const NUMBERED_INDENT = /^[ \t]*(?=\d{1,3}[.)][ \t]+)/;

export function isListLine(line: string): boolean {
  return LIST_LINE.test(line);
}

/**
 * Joins wrapped lines into flowing paragraphs. Blank lines still separate paragraphs, list
 * items and table rows (lines with tabs) stay on their own lines, and a word hyphenated at
 * the end of a line ("exam-\nple") is joined back ("example").
 */
export function mergeLinesStep(text: string): StepResult {
  const out: string[] = [];
  const edits: Edit[] = [];
  let open = false;
  // Where the open output line's kept text ends in the input, where its last input line
  // ends, and whether that line lost its trailing whitespace (merged lines are trimmed).
  let tail = { contentEnd: 0, lineEnd: 0, trimmed: false };
  const closeTail = () => {
    if (tail.trimmed && tail.lineEnd > tail.contentEnd) edits.push({ start: tail.contentEnd, end: tail.lineEnd, kind: 'whitespace' });
    tail = { contentEnd: 0, lineEnd: 0, trimmed: false };
  };

  forEachLine(text, (start, end) => {
    const line = text.slice(start, end);
    if (!line.trim()) {
      closeTail();
      if (end > start) edits.push({ start, end, kind: 'whitespace' });
      out.push('');
      open = false;
      return;
    }
    const table = line.includes('\t');
    const previous = out[out.length - 1];
    if (!open || previous === undefined || isListLine(line) || table || previous.includes('\t')) {
      closeTail();
      out.push(line);
      open = !table;
      tail = { contentEnd: start + line.trimEnd().length, lineEnd: end, trimmed: false };
      return;
    }
    const leading = line.length - line.trimStart().length;
    const next = line.trim();
    if (/\p{Ll}-$/u.test(previous) && /^\p{Ll}/u.test(next)) {
      out[out.length - 1] = previous.slice(0, -1) + next;
      edits.push({ start: tail.contentEnd - 1, end: start + leading, kind: 'line-break' });
    } else {
      out[out.length - 1] = `${previous.trimEnd()} ${next}`;
      edits.push({ start: tail.contentEnd, end: start + leading, insert: ' ', kind: 'line-break' });
    }
    tail = { contentEnd: start + leading + next.length, lineEnd: end, trimmed: true };
  });
  closeTail();
  return { text: out.join('\n'), edits };
}

/** Removes bullet markers and list indentation; numbered items keep their numbers. */
export function stripBulletsStep(text: string): StepResult {
  const edits: Edit[] = [];
  const lines: string[] = [];
  forEachLine(text, (start, end) => {
    const line = text.slice(start, end);
    if (!isListLine(line)) {
      lines.push(line);
      return;
    }
    const marker = BULLET.exec(line)?.[0] ?? NUMBERED_INDENT.exec(line)?.[0] ?? '';
    if (marker) edits.push({ start, end: start + marker.length, kind: 'bullet' });
    lines.push(line.slice(marker.length));
  });
  return { text: lines.join('\n'), edits };
}

// --- Helpers --------------------------------------------------------------------------------

/** Calls `fn(start, end)` for every line (end is the index of its "\n" or the text length). */
export function forEachLine(text: string, fn: (start: number, end: number) => void): void {
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    fn(start, end);
    if (newline === -1) return;
    start = newline + 1;
  }
}

function withMask(text: string, removed: Uint8Array, kind: Edit['kind']): StepResult {
  const edits = maskToEdits(removed, kind);
  return { text: applyEditsToText(text, edits), edits };
}
