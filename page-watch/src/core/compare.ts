import { diffLines, diffStats, toHunks, type DiffOp } from './diff';
import { collapseSpaces, splitLines } from './normalize';
import { extractNumbers, sameNumbers, type NumberToken } from './numbers';
import type { ChangeMode, DiffLine } from './types';

export interface ChangeRule {
  mode: ChangeMode;
  keyword: string;
}

export interface Evaluation {
  /** Whether this counts as a change under the watch's rule (and should notify). */
  changed: boolean;
  summary: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  truncated: boolean;
}

const MINUS = '−';

/**
 * Compares two snapshots under a watch's rule. Returns null when the text is identical.
 * The diff is always computed so the viewer can show what moved, even in number and
 * keyword modes.
 */
export function evaluateChange(prevText: string, nextText: string, rule: ChangeRule): Evaluation | null {
  if (prevText === nextText) return null;
  const ops = diffLines(splitLines(prevText), splitLines(nextText));
  const { added, removed } = diffStats(ops);
  const { lines, truncated } = toHunks(ops);
  const base = { added, removed, lines, truncated };

  switch (rule.mode) {
    case 'number': {
      const before = extractNumbers(prevText);
      const after = extractNumbers(nextText);
      if (sameNumbers(before, after)) return { ...base, changed: false, summary: textSummary(ops, added, removed) };
      return { ...base, changed: true, summary: numberSummary(before, after) };
    }
    case 'keyword': {
      const was = hasKeyword(prevText, rule.keyword);
      const is = hasKeyword(nextText, rule.keyword);
      const summary = was === is ? textSummary(ops, added, removed) : keywordSummary(rule.keyword, is);
      return { ...base, changed: was !== is, summary };
    }
    default:
      return { ...base, changed: true, summary: textSummary(ops, added, removed) };
  }
}

export function hasKeyword(text: string, keyword: string): boolean {
  const needle = collapseSpaces(keyword).toLowerCase();
  return needle.length > 0 && collapseSpaces(text).toLowerCase().includes(needle);
}

function quote(text: string, max = 40): string {
  const clean = collapseSpaces(text);
  return `“${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}”`;
}

export function keywordSummary(keyword: string, present: boolean): string {
  return `${quote(keyword)} ${present ? 'appeared' : 'disappeared'}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "Changed: “Out of stock” → “In stock”" for a one-line swap, otherwise "+3 lines, −1 line". */
export function textSummary(ops: readonly DiffOp[], added: number, removed: number): string {
  if (added === 1 && removed === 1) {
    const oldLine = ops.find((op) => op.type === 'remove')!.text;
    const newLine = ops.find((op) => op.type === 'add')!.text;
    if (oldLine.length <= 80 && newLine.length <= 80) return `Changed: ${quote(oldLine)} → ${quote(newLine)}`;
  }
  const parts: string[] = [];
  if (added) parts.push(`+${plural(added, 'line')}`);
  if (removed) parts.push(`${MINUS}${plural(removed, 'line')}`);
  return parts.join(', ') || 'Text changed';
}

/** "Price changed: $129 → $99", "New number: 12", "(+2 more)" when several moved. */
export function numberSummary(before: readonly NumberToken[], after: readonly NumberToken[]): string {
  const ops = diffLines(
    before.map((token) => token.raw),
    after.map((token) => token.raw),
  );
  const isPrice = (raw: string) => before.some((t) => t.raw === raw && t.isPrice) || after.some((t) => t.raw === raw && t.isPrice);

  const events: string[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i++) {
      const label = isPrice(removed[i]!) || isPrice(added[i]!) ? 'Price' : 'Number';
      events.push(`${label} changed: ${removed[i]} → ${added[i]}`);
    }
    for (const raw of removed.slice(pairs)) events.push(`${isPrice(raw) ? 'Price' : 'Number'} removed: ${raw}`);
    for (const raw of added.slice(pairs)) events.push(`New ${isPrice(raw) ? 'price' : 'number'}: ${raw}`);
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op.type === 'remove') removed.push(op.text);
    else if (op.type === 'add') added.push(op.text);
    else flush();
  }
  flush();

  const [first, ...rest] = events;
  if (!first) return 'Numbers changed';
  return rest.length ? `${first} (+${rest.length} more)` : first;
}
