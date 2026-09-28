import type { DiffLine } from './types';

export interface DiffOp {
  type: 'equal' | 'add' | 'remove';
  text: string;
  /** Explained by a noise rule (its id): shown greyed, not counted as a change. */
  ignored?: string;
}

/**
 * Past this many edits the exact diff is skipped (the page was rewritten wholesale) and the
 * changed middle is reported as removed + added. Keeps time and memory bounded.
 */
export const MAX_EDITS = 1500;

/**
 * Line-level diff (Myers' O(ND) algorithm) after trimming the common prefix and suffix,
 * which makes the usual "one line changed on a big page" case cheap.
 * Invariant: equal+remove lines rebuild `a`, equal+add lines rebuild `b`.
 */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits = MAX_EDITS): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'equal', text: a[i]! });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB, maxEdits);
  if (middle) {
    ops.push(...middle);
  } else {
    for (const text of midA) ops.push({ type: 'remove', text });
    for (const text of midB) ops.push({ type: 'add', text });
  }
  for (let i = endA; i < a.length; i++) ops.push({ type: 'equal', text: a[i]! });
  return ops;
}

function myers(a: readonly string[], b: readonly string[], maxEdits: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: 'add', text }));
  if (m === 0) return a.map((text) => ({ type: 'remove', text }));

  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // trace[d] holds v[-d-1 .. d+1] as it was before round d.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: readonly string[], b: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const at = (k: number) => v[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', text: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'add', text: b[y - 1]! });
      else ops.push({ type: 'remove', text: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(ops: readonly DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'remove') removed++;
  }
  return { added, removed };
}

export interface HunkOptions {
  /** Unchanged lines shown around each change. */
  context?: number;
  /** Changed lines kept at most; the rest is dropped and `truncated` is set. */
  maxChangedLines?: number;
  /** Longer lines are cut. */
  maxLineChars?: number;
}

/**
 * Folds a diff for display and storage: changed lines, `context` unchanged lines around
 * them, and `skip` markers for everything else.
 */
export function toHunks(ops: readonly DiffOp[], options: HunkOptions = {}): { lines: DiffLine[]; truncated: boolean } {
  const context = options.context ?? 2;
  const maxChanged = options.maxChangedLines ?? 80;
  const maxChars = options.maxLineChars ?? 300;

  const show = new Uint8Array(ops.length);
  ops.forEach((op, index) => {
    if (op.type === 'equal') return;
    for (let i = Math.max(0, index - context); i <= Math.min(ops.length - 1, index + context); i++) show[i] = 1;
  });

  const lines: DiffLine[] = [];
  let changed = 0;
  let skipped = 0;
  let truncated = false;
  const cut = (text: string) => (text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text);
  const flushSkip = () => {
    if (skipped > 0) lines.push({ type: 'skip', text: '', count: skipped });
    skipped = 0;
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (!show[i]) {
      skipped++;
      continue;
    }
    if (op.type !== 'equal') {
      if (changed >= maxChanged) {
        truncated = true;
        break;
      }
      changed++;
    }
    flushSkip();
    const line: DiffLine = { type: op.type === 'equal' ? 'context' : op.type, text: cut(op.text) };
    if (op.ignored && op.type !== 'equal') line.ignored = op.ignored;
    lines.push(line);
  }
  if (!truncated) flushSkip();
  return { lines, truncated };
}
