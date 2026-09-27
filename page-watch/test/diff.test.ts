import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, toHunks, type DiffOp } from '../src/core/diff';

function rebuild(ops: DiffOp[]) {
  return {
    a: ops.filter((op) => op.type !== 'add').map((op) => op.text),
    b: ops.filter((op) => op.type !== 'remove').map((op) => op.text),
  };
}

/** Classic O(nm) LCS length, the reference for minimality. */
function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe('diffLines', () => {
  it('returns only equal lines for identical input', () => {
    const ops = diffLines(['a', 'b'], ['a', 'b']);
    expect(ops.every((op) => op.type === 'equal')).toBe(true);
    expect(diffStats(ops)).toEqual({ added: 0, removed: 0 });
  });

  it('handles empty sides', () => {
    expect(diffLines([], ['x', 'y'])).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
    expect(diffLines(['x'], [])).toEqual([{ type: 'remove', text: 'x' }]);
    expect(diffLines([], [])).toEqual([]);
  });

  it('finds a single replaced line in the middle', () => {
    const ops = diffLines(['Title', 'Price: $129', 'In stock'], ['Title', 'Price: $99', 'In stock']);
    expect(ops).toEqual([
      { type: 'equal', text: 'Title' },
      { type: 'remove', text: 'Price: $129' },
      { type: 'add', text: 'Price: $99' },
      { type: 'equal', text: 'In stock' },
    ]);
  });

  it('keeps insertions in place', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c', 'y']);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 0 });
    expect(rebuild(ops)).toEqual({ a: ['a', 'b', 'c'], b: ['a', 'x', 'b', 'c', 'y'] });
  });

  it('is minimal and reversible on random inputs', () => {
    const random = seeded(42);
    const alphabet = ['a', 'b', 'c', 'd', 'e'];
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: Math.floor(random() * 14) }, () => alphabet[Math.floor(random() * 5)]!);
      const b = Array.from({ length: Math.floor(random() * 14) }, () => alphabet[Math.floor(random() * 5)]!);
      const ops = diffLines(a, b);
      expect(rebuild(ops)).toEqual({ a, b });
      const { added, removed } = diffStats(ops);
      expect(added + removed).toBe(a.length + b.length - 2 * lcsLength(a, b));
    }
  });

  it('falls back to remove-all/add-all past the edit budget, still reversible', () => {
    const a = Array.from({ length: 50 }, (_, i) => `old ${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `new ${i}`);
    const ops = diffLines(['same', ...a, 'end'], ['same', ...b, 'end'], 10);
    expect(diffStats(ops)).toEqual({ added: 50, removed: 50 });
    expect(rebuild(ops)).toEqual({ a: ['same', ...a, 'end'], b: ['same', ...b, 'end'] });
  });

  it('diffs a large page with a small change quickly', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `Line number ${i}`);
    const b = [...a];
    b[10_000] = 'Changed line';
    b.splice(15_000, 0, 'Inserted');
    const started = performance.now();
    const ops = diffLines(a, b);
    expect(performance.now() - started).toBeLessThan(500);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
  });
});

describe('toHunks', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`);

  it('keeps changes with context and folds the rest', () => {
    const b = [...a];
    b[10] = 'changed';
    const { lines, truncated } = toHunks(diffLines(a, b), { context: 2 });
    expect(truncated).toBe(false);
    expect(lines).toEqual([
      { type: 'skip', text: '', count: 8 },
      { type: 'context', text: 'line 8' },
      { type: 'context', text: 'line 9' },
      { type: 'remove', text: 'line 10' },
      { type: 'add', text: 'changed' },
      { type: 'context', text: 'line 11' },
      { type: 'context', text: 'line 12' },
      { type: 'skip', text: '', count: 7 },
    ]);
  });

  it('merges nearby changes into one hunk', () => {
    const b = [...a];
    b[5] = 'x';
    b[8] = 'y';
    const { lines } = toHunks(diffLines(a, b), { context: 2 });
    expect(lines.filter((line) => line.type === 'skip')).toHaveLength(2);
  });

  it('caps changed lines and long lines', () => {
    const b = a.map((line) => `${line} ${'z'.repeat(400)}`);
    const { lines, truncated } = toHunks(diffLines(a, b), { maxChangedLines: 6, maxLineChars: 50 });
    expect(truncated).toBe(true);
    expect(lines.filter((line) => line.type !== 'context' && line.type !== 'skip')).toHaveLength(6);
    expect(Math.max(...lines.map((line) => line.text.length))).toBeLessThanOrEqual(50);
  });
});
