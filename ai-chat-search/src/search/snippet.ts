import { foldWithMap, tokensWithOffsets } from './normalize';
import type { Clause } from './query';

/** A piece of text; `match` pieces are shown highlighted. Rendered with text nodes and <mark>. */
export interface Segment {
  text: string;
  match: boolean;
}

interface Range {
  start: number;
  end: number;
}

/** Where the clauses match in `text`, as ranges of the original (unfolded) text. */
export function matchRanges(text: string, clauses: readonly Clause[]): Range[] {
  if (clauses.length === 0 || !text) return [];
  const { folded, map } = foldWithMap(text);
  const tokens = tokensWithOffsets(folded);
  const ranges: Range[] = [];
  for (const clause of clauses) {
    const count = clause.tokens.length;
    for (let i = 0; i + count <= tokens.length; i++) {
      let ok = true;
      for (let j = 0; j < count; j++) {
        const token = tokens[i + j]?.value ?? '';
        const wanted = clause.tokens[j] ?? '';
        const last = j === count - 1;
        // Every token but the last must match exactly; the last is a prefix unless the clause is a quoted phrase.
        const matches = last && clause.kind !== 'phrase' ? token.startsWith(wanted) : token === wanted;
        if (!matches) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const first = tokens[i];
      const lastToken = tokens[i + count - 1];
      if (!first || !lastToken) continue;
      ranges.push({ start: map[first.start] ?? 0, end: map[lastToken.end] ?? text.length });
    }
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** The whole text with matches marked (for titles). */
export function highlight(text: string, clauses: readonly Clause[]): Segment[] {
  return toSegments(text, matchRanges(text, clauses), 0, text.length);
}

/**
 * A short excerpt around the densest group of matches, whitespace collapsed, with "…" where text
 * was cut. Without matches, the beginning of the text.
 */
export function makeSnippet(text: string, clauses: readonly Clause[], maxLength = 200): Segment[] {
  const ranges = matchRanges(text, clauses);
  let start = 0;
  if (ranges.length > 0) {
    // The window that covers the most matches, starting a little before its first match.
    let bestIndex = 0;
    let bestCount = 0;
    for (let i = 0; i < ranges.length; i++) {
      const windowStart = ranges[i]?.start ?? 0;
      let count = 0;
      for (let j = i; j < ranges.length && (ranges[j]?.end ?? 0) <= windowStart + maxLength; j++) count++;
      if (count > bestCount) {
        bestCount = count;
        bestIndex = i;
      }
    }
    const first = ranges[bestIndex]?.start ?? 0;
    start = Math.max(0, first - Math.floor(maxLength / 4));
    // Don't start in the middle of a word.
    if (start > 0) {
      const space = text.slice(start, first).search(/\s/);
      start = space === -1 ? first : start + space + 1;
    }
  }
  let end = Math.min(text.length, start + maxLength);
  if (end < text.length) {
    const cut = text.slice(start, end).search(/\s\S*$/);
    if (cut > maxLength / 2) end = start + cut;
  }
  const segments = toSegments(text, ranges, start, end);
  if (start > 0) segments.unshift({ text: '…', match: false });
  if (end < text.length) segments.push({ text: '…', match: false });
  return segments;
}

function toSegments(text: string, ranges: Range[], start: number, end: number): Segment[] {
  const segments: Segment[] = [];
  let cursor = start;
  const push = (from: number, to: number, match: boolean) => {
    if (to <= from) return;
    const piece = text.slice(from, to).replace(/\s+/g, ' ');
    const previous = segments[segments.length - 1];
    if (previous && previous.match === match) previous.text += piece;
    else segments.push({ text: piece, match });
  };
  for (const range of ranges) {
    if (range.end <= start || range.start >= end) continue;
    push(cursor, Math.max(cursor, range.start), false);
    push(Math.max(cursor, range.start), Math.min(end, range.end), true);
    cursor = Math.min(end, range.end);
  }
  push(cursor, end, false);
  const first = segments[0];
  if (first && !first.match) first.text = first.text.trimStart();
  const last = segments[segments.length - 1];
  if (last && !last.match) last.text = last.text.trimEnd();
  return segments.filter((segment) => segment.text !== '');
}
