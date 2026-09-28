import type { DiffOp } from './diff';
import { diffLines } from './diff';
import { splitLines } from './normalize';
import { isWord, lcsPairs, letterCount, tokenize } from './words';

/**
 * Automatic noise filter. Pages are full of text that changes on every visit without anything
 * really changing: timestamps, "12 people are viewing this", request ids, rotating
 * recommendations, shuffled "trending" lists. When a watch is added, the page is fetched a
 * second time a few seconds later; whatever changed in between is learned as noise and left
 * out of change detection for that watch. The first few regular checks then confirm the rules:
 * a rule that never fires again was a one-off and is dropped.
 *
 * Rules are narrow on purpose, so a real change still gets through:
 * - segment: only the changing part of a line, found by the words around it
 *   ("… people are viewing this"); the rest of the line is still compared.
 * - block: the lines between two unchanged anchor lines (rotating recommendations).
 * - order: the order of a list's items (a shuffled "trending" list). A new or removed item
 *   still counts.
 */

/** The learning fetch comes this long after the watch is added (Chrome may delay it to 30 s). */
export const LEARN_DELAY_MS = 10_000;
/** Regular checks that confirm the learned rules. */
export const LEARN_CHECKS = 3;
export const MAX_RULES = 40;
/** A block rule covers at most this many lines. */
export const MAX_BLOCK_LINES = 200;
/** Words of context kept on each side of a changing segment. */
const CONTEXT_WORDS = 3;
const MAX_ANCHOR_LINES = 3;
/** Stands for ignored text in masked lines and in the popup. */
export const GAP = '…';

export interface SegmentRule {
  kind: 'segment';
  /** Rules learned from the same line share an id (the popup ignores and restores them together). */
  id: string;
  /** Text right before and after the changing part. */
  left: string;
  right: string;
  /** The context reaches the start / end of the line. */
  start: boolean;
  end: boolean;
  /** The line it was learned from. */
  sample: string;
  /** Confirming checks in which it fired. */
  hits: number;
}

export interface BlockRule {
  kind: 'block';
  id: string;
  /** Unchanged lines right before the block; null when the block starts the text. */
  before: string[] | null;
  /** Unchanged lines right after it; null when it ends the text. */
  after: string[] | null;
  /** Lines it had when learned. */
  lines: number;
  sample: string;
  hits: number;
}

export interface OrderRule {
  kind: 'order';
  id: string;
  /** The list's items: consecutive lines among them are compared in any order. */
  items: string[];
  /** The unchanged line right before the list (its heading, usually), to say where it is. */
  anchor: string | null;
  sample: string;
  hits: number;
}

export type NoiseRule = SegmentRule | BlockRule | OrderRule;

/** pair: waiting for the learning fetch · confirm: regular checks confirm the rules · done. */
export type NoisePhase = 'pair' | 'confirm' | 'done';

export interface NoiseState {
  phase: NoisePhase;
  checksLeft: number;
  rules: NoiseRule[];
}

export function emptyNoise(phase: NoisePhase = 'pair'): NoiseState {
  return { phase, checksLeft: 0, rules: [] };
}

/** Short stable id (FNV-1a) for keys and the popup. */
export function hashId(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function ruleKey(rule: NoiseRule): string {
  if (rule.kind === 'segment') return `s|${rule.start}|${rule.left}|${rule.right}|${rule.end}`;
  if (rule.kind === 'order') return `o|${JSON.stringify([...rule.items].sort())}`;
  return `b|${JSON.stringify(rule.before)}|${JSON.stringify(rule.after)}`;
}

/** An order rule covers at most this many items. */
export const MAX_ORDER_ITEMS = 200;

// --- Learning -----------------------------------------------------------------------------------

function takeWords(tokens: readonly string[], fromEnd: boolean): string[] {
  const out: string[] = [];
  let words = 0;
  for (let k = 0; k < tokens.length && words < CONTEXT_WORDS; k++) {
    const token = tokens[fromEnd ? tokens.length - 1 - k : k]!;
    out.push(token);
    if (isWord(token)) words++;
  }
  return fromEnd ? out.reverse() : out;
}

function mostlyFixed(tokens: readonly string[], fixed: Uint8Array): boolean {
  let words = 0;
  let fixedWords = 0;
  let fixedText = '';
  tokens.forEach((token, index) => {
    if (!isWord(token)) return;
    words++;
    if (fixed[index]) {
      fixedWords++;
      fixedText += token;
    }
  });
  return words > 0 && fixedWords / words >= 0.5 && letterCount(fixedText) >= 3;
}

type Segment = Pick<SegmentRule, 'left' | 'right' | 'start' | 'end'>;

/**
 * The changing parts of a line that changed ("12 people…" → "15 people…"), each with the
 * words around it. Null when the lines have too little in common to tell what changed
 * (then the change is learned as a block).
 */
export function lineSegments(before: string, after: string): Segment[] | null {
  const a = tokenize(before);
  const b = tokenize(after);
  const pairs = lcsPairs(a, b);
  if (!pairs || pairs.length === 0) return null;
  const fixedA = new Uint8Array(a.length);
  const fixedB = new Uint8Array(b.length);
  for (const [i, j] of pairs) {
    fixedA[i] = 1;
    fixedB[j] = 1;
  }
  if (!mostlyFixed(a, fixedA) || !mostlyFixed(b, fixedB)) return null;

  // The line as runs of unchanged tokens (arrays) and changing gaps (null).
  const parts: (string[] | null)[] = [];
  let nextA = 0;
  let nextB = 0;
  const gap = () => {
    if (parts.length === 0 || parts[parts.length - 1] !== null) parts.push(null);
  };
  for (const [i, j] of pairs) {
    if (i > nextA || j > nextB) gap();
    const last = parts[parts.length - 1];
    if (last) last.push(a[i]!);
    else parts.push([a[i]!]);
    nextA = i + 1;
    nextB = j + 1;
  }
  if (nextA < a.length || nextB < b.length) gap();

  const segments: Segment[] = [];
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] !== null) continue;
    const previous = parts[index - 1] ?? null;
    const next = parts[index + 1] ?? null;
    const left = previous ? takeWords(previous, true) : [];
    const right = next ? takeWords(next, false) : [];
    const segment: Segment = {
      left: left.join(''),
      right: right.join(''),
      start: index === 0 || (index === 1 && left.length === previous!.length),
      end: index === parts.length - 1 || (index === parts.length - 2 && right.length === next!.length),
    };
    // Context without words ("$…", "… · …") would match unrelated lines.
    if (letterCount(segment.left + segment.right) < 3) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments : null;
}

/** A run of changed lines (not counting lines that only moved), by op index, inclusive. */
interface Hunk {
  first: number;
  last: number;
  removed: string[];
  added: string[];
}

function countSeq(lines: readonly string[], seq: readonly string[]): number {
  let count = 0;
  for (let i = 0; i + seq.length <= lines.length; i++) {
    if (seq.every((line, k) => lines[i + k] === line)) count++;
  }
  return count;
}

function indexOfSeq(lines: readonly string[], seq: readonly string[], from: number): number {
  for (let i = from; i + seq.length <= lines.length; i++) {
    if (seq.every((line, k) => lines[i + k] === line)) return i;
  }
  return -1;
}

/**
 * The shortest run of unchanged lines next to a hunk that appears exactly once in both texts.
 * null: the hunk starts (or ends) the text. undefined: no usable anchor.
 */
function anchor(ops: readonly DiffOp[], from: number, step: 1 | -1, a: readonly string[], b: readonly string[]): string[] | null | undefined {
  const run: string[] = [];
  let index = from;
  while (index >= 0 && index < ops.length && ops[index]!.type === 'equal' && run.length < MAX_ANCHOR_LINES) {
    run.push(ops[index]!.text);
    index += step;
  }
  const reachesEdge = index < 0 || index >= ops.length;
  if (run.length === 0) return reachesEdge ? null : undefined;
  for (let size = 1; size <= run.length; size++) {
    const seq = step === -1 ? run.slice(0, size).reverse() : run.slice(0, size);
    if (countSeq(a, seq) === 1 && countSeq(b, seq) === 1) return seq;
  }
  return undefined;
}

function blockRule(ops: readonly DiffOp[], hunk: Hunk, a: readonly string[], b: readonly string[]): BlockRule | null {
  const before = anchor(ops, hunk.first - 1, -1, a, b);
  const after = anchor(ops, hunk.last + 1, 1, a, b);
  // Both ends open would ignore the whole text.
  if (before === undefined || after === undefined || (before === null && after === null)) return null;
  const lines = Math.max(hunk.removed.length, hunk.added.length);
  if (lines > MAX_BLOCK_LINES) return null;
  const sample = hunk.removed[0] ?? hunk.added[0] ?? '';
  return { kind: 'block', id: hashId(`b|${JSON.stringify(before)}|${JSON.stringify(after)}`), before, after, lines, sample, hits: 0 };
}

/**
 * Rules for everything that changed between two fetches of the same page taken seconds apart.
 */
export function learnNoise(prevText: string, nextText: string): NoiseRule[] {
  if (prevText === nextText) return [];
  const a = splitLines(prevText);
  const b = splitLines(nextText);
  const ops = diffLines(a, b);

  // Lines removed in one place and added in another only moved: a shuffled list.
  const removedCount = new Map<string, number>();
  const addedCount = new Map<string, number>();
  for (const op of ops) {
    if (op.type === 'remove') removedCount.set(op.text, (removedCount.get(op.text) ?? 0) + 1);
    if (op.type === 'add') addedCount.set(op.text, (addedCount.get(op.text) ?? 0) + 1);
  }
  const moved = (op: DiffOp) => op.type !== 'equal' && (removedCount.get(op.text) ?? 0) > 0 && (addedCount.get(op.text) ?? 0) > 0;

  const rules: NoiseRule[] = [];
  // The list is every line from the first moved one until each moved line is back, equal ones included.
  for (let index = 0; index < ops.length; index++) {
    if (!moved(ops[index]!)) continue;
    const balance = new Map<string, number>();
    const items: string[] = [];
    let end = index;
    for (let k = index; k < ops.length; k++) {
      const op = ops[k]!;
      if (op.type !== 'equal' && !moved(op)) continue;
      items.push(op.text);
      end = k;
      if (op.type === 'equal') continue;
      balance.set(op.text, (balance.get(op.text) ?? 0) + (op.type === 'remove' ? 1 : -1));
      if ([...balance.values()].every((value) => value === 0)) break;
    }
    // Trailing unchanged lines after the last move aren't part of the list.
    while (items.length > 0 && ops[end]!.type === 'equal') {
      items.pop();
      end--;
    }
    const unique = [...new Set(items)].slice(0, MAX_ORDER_ITEMS);
    const before = ops[index - 1];
    const anchor = before?.type === 'equal' ? before.text : null;
    if (unique.length > 1) rules.push({ kind: 'order', id: hashId(`o|${JSON.stringify([...unique].sort())}`), items: unique, anchor, sample: unique[0]!, hits: 0 });
    index = end;
  }

  // What changed for real: runs of changed lines that didn't just move.
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  ops.forEach((op, index) => {
    // A moved line inside a run of changes doesn't split it ("remove X, add moved, add Y" is X → Y).
    if (moved(op)) return;
    if (op.type === 'equal') {
      current = null;
      return;
    }
    if (!current) {
      current = { first: index, last: index, removed: [], added: [] };
      hunks.push(current);
    }
    current.last = index;
    (op.type === 'remove' ? current.removed : current.added).push(op.text);
  });

  for (const hunk of hunks) {
    let segments: NoiseRule[] | null = null;
    if (hunk.removed.length > 0 && hunk.removed.length === hunk.added.length) {
      segments = [];
      for (let k = 0; k < hunk.removed.length && segments; k++) {
        const found = lineSegments(hunk.removed[k]!, hunk.added[k]!);
        if (!found) segments = null;
        else for (const segment of found) segments.push({ kind: 'segment', id: hashId(hunk.removed[k]!), ...segment, sample: hunk.removed[k]!, hits: 0 });
      }
    }
    if (segments) rules.push(...segments);
    else {
      const rule = blockRule(ops, hunk, a, b);
      if (rule) rules.push(rule);
    }
  }
  return mergeRules([], rules);
}

/** Existing rules first, duplicates dropped, capped. */
export function mergeRules(existing: readonly NoiseRule[], learned: readonly NoiseRule[]): NoiseRule[] {
  const seen = new Set<string>();
  const out: NoiseRule[] = [];
  for (const rule of [...existing, ...learned]) {
    const key = ruleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out.slice(0, MAX_RULES);
}

// --- Applying the rules -------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const regexCache = new Map<string, RegExp>();

function segmentRegex(rule: SegmentRule): RegExp {
  const key = ruleKey(rule);
  let regex = regexCache.get(key);
  if (!regex) {
    regex = new RegExp(`${rule.start ? '^' : ''}${escapeRegExp(rule.left)}(.*?)${escapeRegExp(rule.right)}${rule.end ? '$' : ''}`, 'u');
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(key, regex);
  }
  return regex;
}

/** The line with its changing segments replaced by "…", and the id of the first rule that applied. */
export function maskLine(line: string, rules: readonly NoiseRule[]): { text: string; id: string | null } {
  let text = line;
  let id: string | null = null;
  for (const rule of rules) {
    if (rule.kind !== 'segment') continue;
    const regex = segmentRegex(rule);
    if (!regex.test(text)) continue;
    text = text.replace(regex, () => `${rule.left}${GAP}${rule.right}`);
    id ??= rule.id;
  }
  return { text, id };
}

/** Where a block rule applies in these lines: [start, end), or null. */
export function findBlock(lines: readonly string[], rule: BlockRule): [number, number] | null {
  let start = 0;
  if (rule.before) {
    if (countSeq(lines, rule.before) !== 1) return null;
    start = indexOfSeq(lines, rule.before, 0) + rule.before.length;
  }
  let end = lines.length;
  if (rule.after) {
    end = indexOfSeq(lines, rule.after, start);
    if (end < 0) return null;
  }
  return end - start > MAX_BLOCK_LINES ? null : [start, end];
}

interface Coverage {
  blocks: { rule: BlockRule; start: number; end: number }[];
  /** The block rule each line falls in. */
  blockOf: (BlockRule | null)[];
  /** The order rule each line (outside blocks) is an item of. */
  orderOf: (OrderRule | null)[];
  /** Each line with segment rules applied. */
  masked: string[];
  /** The segment rule id that changed the line. */
  segmentOf: (string | null)[];
}

function cover(lines: readonly string[], rules: readonly NoiseRule[]): Coverage {
  const blocks: Coverage['blocks'] = [];
  const blockOf: (BlockRule | null)[] = lines.map(() => null);
  for (const rule of rules) {
    if (rule.kind !== 'block') continue;
    const range = findBlock(lines, rule);
    if (!range) continue;
    const [start, end] = range;
    const overlaps = blocks.some((block) => (start < block.end && block.start < end) || (start === end && start > block.start && start < block.end));
    if (overlaps) continue;
    blocks.push({ rule, start, end });
    for (let i = start; i < end; i++) blockOf[i] = rule;
  }
  blocks.sort((x, y) => x.start - y.start);
  const orders = rules.filter((rule): rule is OrderRule => rule.kind === 'order').map((rule) => [rule, new Set(rule.items)] as const);
  const orderOf = lines.map((line, index) => (blockOf[index] ? null : (orders.find(([, items]) => items.has(line))?.[0] ?? null)));
  const masked: string[] = [];
  const segmentOf: (string | null)[] = [];
  for (const line of lines) {
    const result = maskLine(line, rules);
    masked.push(result.text);
    segmentOf.push(result.id);
  }
  return { blocks, blockOf, orderOf, masked, segmentOf };
}

/**
 * The text as change detection sees it: changing segments replaced by "…", ignored blocks
 * collapsed to one "…" line, consecutive items of a shuffled list sorted.
 */
export function maskText(text: string, rules: readonly NoiseRule[]): string {
  if (rules.length === 0) return text;
  const lines = splitLines(text);
  const { blocks, orderOf, masked } = cover(lines, rules);
  const out: string[] = [];
  let next = 0;
  let i = 0;
  while (i <= lines.length) {
    const block = blocks[next];
    if (block && block.start === i) {
      out.push(GAP);
      i = block.end;
      next++;
      continue;
    }
    if (i === lines.length) break;
    const order = orderOf[i];
    if (order) {
      let j = i;
      while (j < lines.length && orderOf[j] === order) j++;
      out.push(...masked.slice(i, j).sort());
      i = j;
      continue;
    }
    out.push(masked[i]!);
    i++;
  }
  return out.join('\n');
}

export type AnnotatedOp = DiffOp & { ignored?: string };

function multiset(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function take(counts: Map<string, number> | undefined, value: string): boolean {
  const count = counts?.get(value) ?? 0;
  if (count <= 0) return false;
  counts!.set(value, count - 1);
  return true;
}

/**
 * Marks the diff lines explained by noise rules (`ignored` = the rule id) and reports which
 * rules fired. A line only counts as noise when its counterpart is there on the other side
 * ("12 people…" → "15 people…", a list item that moved); a noisy line that disappears or a
 * new item in a shuffled list is a real change.
 */
export function annotateOps(
  ops: readonly DiffOp[],
  a: readonly string[],
  b: readonly string[],
  rules: readonly NoiseRule[],
): { ops: AnnotatedOp[]; fired: Set<string> } {
  const fired = new Set<string>();
  if (rules.length === 0) return { ops: [...ops], fired };
  const sides = [cover(a, rules), cover(b, rules)] as const;
  // Each side's changed lines are matched against the other side.
  const counters = ([0, 1] as const).map((side) => {
    const opposite = sides[side === 0 ? 1 : 0];
    const oppositeLines = side === 0 ? b : a;
    const segments = multiset(opposite.masked.filter((_, index) => opposite.segmentOf[index] !== null));
    const found = new Set(opposite.blocks.map((block) => block.rule));
    const items = new Map<OrderRule, Map<string, number>>();
    opposite.orderOf.forEach((rule, index) => {
      if (!rule) return;
      const counts = items.get(rule) ?? new Map<string, number>();
      counts.set(oppositeLines[index]!, (counts.get(oppositeLines[index]!) ?? 0) + 1);
      items.set(rule, counts);
    });
    return { segments, found, items };
  });

  const out: AnnotatedOp[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op.type === 'equal') {
      out.push(op);
      i++;
      j++;
      continue;
    }
    const side: 0 | 1 = op.type === 'remove' ? 0 : 1;
    const index = side === 0 ? i++ : j++;
    const own = sides[side];
    const counter = counters[side]!;
    let ignored: string | undefined;
    const block = own.blockOf[index];
    const order = own.orderOf[index];
    const segment = own.segmentOf[index];
    if (block && counter.found.has(block)) ignored = block.id;
    else if (order && take(counter.items.get(order), op.text)) ignored = order.id;
    else if (segment && take(counter.segments, own.masked[index]!)) ignored = segment;
    if (ignored) fired.add(ignored);
    out.push(ignored ? { ...op, ignored } : op);
  }
  return { ops: out, fired };
}

// --- State ------------------------------------------------------------------------------------------

/** The learning fetch is in: learn from it, then confirm over the next regular checks. */
export function learnFromPair(state: NoiseState, prevText: string, nextText: string): NoiseState {
  return { phase: 'confirm', checksLeft: LEARN_CHECKS, rules: mergeRules(state.rules, learnNoise(prevText, nextText)) };
}

/**
 * After a regular check while confirming: count the rules that fired. At the end, rules that
 * never fired again are dropped (a one-off change right after adding, not noise).
 */
export function confirmRules(state: NoiseState, fired: Iterable<string>): NoiseState {
  if (state.phase !== 'confirm') return state;
  const hit = new Set(fired);
  const rules = state.rules.map((rule) => (hit.has(rule.id) ? { ...rule, hits: rule.hits + 1 } : rule));
  const checksLeft = state.checksLeft - 1;
  if (checksLeft > 0) return { phase: 'confirm', checksLeft, rules };
  return { phase: 'done', checksLeft: 0, rules: rules.filter((rule) => rule.hits > 0) };
}

/** "Watch this line again": the rules with this id stop applying for good. */
export function removeRules(state: NoiseState, id: string): NoiseState {
  return { ...state, rules: state.rules.filter((rule) => rule.id !== id) };
}

/** Lines the rules ignore, for "2 noisy lines ignored": one per segment line, a block's size, a list's items. */
export function noisyLineCount(rules: readonly NoiseRule[]): number {
  const lines = new Set<string>();
  let count = 0;
  for (const rule of rules) {
    if (rule.kind === 'segment') lines.add(rule.id);
    else if (rule.kind === 'order') count += rule.items.length;
    else count += Math.max(1, rule.lines);
  }
  return count + lines.size;
}

export interface NoiseGroup {
  id: string;
  kind: 'segment' | 'block' | 'order';
  /** What the popup shows: the line with "…" for the changing parts, a block's first line, a list's first items. */
  text: string;
  /** The unchanged line next to a block, to say where it is. */
  anchor: string | null;
  lines: number;
}

/** Rules grouped as the popup lists them, one entry per ignored line or block. */
export function noiseGroups(rules: readonly NoiseRule[]): NoiseGroup[] {
  const groups = new Map<string, NoiseGroup>();
  for (const rule of rules) {
    if (groups.has(rule.id)) continue;
    if (rule.kind === 'segment') {
      const own = rules.filter((item) => item.id === rule.id);
      groups.set(rule.id, { id: rule.id, kind: 'segment', text: maskLine(rule.sample, own).text, anchor: null, lines: 1 });
    } else if (rule.kind === 'order') {
      const text = `${rule.items.slice(0, 3).join(', ')}${rule.items.length > 3 ? ', …' : ''}`;
      groups.set(rule.id, { id: rule.id, kind: 'order', text, anchor: rule.anchor, lines: rule.items.length });
    } else {
      groups.set(rule.id, {
        id: rule.id,
        kind: 'block',
        text: rule.sample,
        anchor: rule.before?.[rule.before.length - 1] ?? rule.after?.[0] ?? null,
        lines: rule.lines,
      });
    }
  }
  return [...groups.values()];
}

// --- Storage ------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lines(raw: unknown): string[] | null | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ANCHOR_LINES || !raw.every((line) => typeof line === 'string')) return undefined;
  return raw.map((line: string) => line.slice(0, 1000));
}

function sanitizeRule(raw: unknown): NoiseRule | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.sample !== 'string') return null;
  const hits = typeof raw.hits === 'number' && Number.isFinite(raw.hits) ? Math.max(0, Math.floor(raw.hits)) : 0;
  const base = { id: raw.id.slice(0, 16), sample: raw.sample.slice(0, 1000), hits };
  if (raw.kind === 'segment') {
    if (typeof raw.left !== 'string' || typeof raw.right !== 'string') return null;
    const rule: SegmentRule = { kind: 'segment', ...base, left: raw.left.slice(0, 300), right: raw.right.slice(0, 300), start: raw.start === true, end: raw.end === true };
    return letterCount(rule.left + rule.right) >= 3 ? rule : null;
  }
  if (raw.kind === 'block') {
    const before = lines(raw.before);
    const after = lines(raw.after);
    if (before === undefined || after === undefined || (before === null && after === null)) return null;
    const count = typeof raw.lines === 'number' && Number.isFinite(raw.lines) ? Math.max(0, Math.min(MAX_BLOCK_LINES, Math.floor(raw.lines))) : 1;
    return { kind: 'block', ...base, before, after, lines: count };
  }
  if (raw.kind === 'order') {
    if (!Array.isArray(raw.items)) return null;
    const items = [...new Set(raw.items.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 1000)))].slice(0, MAX_ORDER_ITEMS);
    const anchor = typeof raw.anchor === 'string' ? raw.anchor.slice(0, 1000) : null;
    return items.length > 1 ? { kind: 'order', ...base, items, anchor } : null;
  }
  return null;
}

export function sanitizeNoise(raw: unknown): NoiseState {
  if (!isRecord(raw)) return emptyNoise('done');
  const phase: NoisePhase = raw.phase === 'pair' || raw.phase === 'confirm' ? raw.phase : 'done';
  const checksLeft = typeof raw.checksLeft === 'number' && Number.isFinite(raw.checksLeft) ? Math.max(0, Math.min(LEARN_CHECKS, Math.floor(raw.checksLeft))) : 0;
  const rules = Array.isArray(raw.rules) ? raw.rules.map(sanitizeRule).filter((rule): rule is NoiseRule => rule !== null) : [];
  return { phase: phase === 'confirm' && checksLeft === 0 ? 'done' : phase, checksLeft, rules: mergeRules([], rules) };
}
