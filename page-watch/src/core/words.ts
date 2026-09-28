/**
 * Word-level tools shared by the noise filter and the diff viewer: a tokenizer that keeps
 * numbers, times and ids whole ("1,299.00", "14:05:32", "7f3a-9c1e"), and a token LCS.
 */

// Words and numbers with their inner separators, runs of whitespace, single symbols.
const TOKEN = /[\p{L}\p{M}\p{N}_]+(?:[.,:'’/-][\p{L}\p{M}\p{N}_]+)*|\s+|[^\s\p{L}\p{M}\p{N}_]/gu;
const WORDISH = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/gu;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** A word or a number (not whitespace or punctuation). */
export function isWord(token: string): boolean {
  return WORDISH.test(token);
}

export function letterCount(text: string): number {
  return text.match(LETTER)?.length ?? 0;
}

/** Past this many tokens per side the LCS is skipped (callers treat the pair as unrelated). */
export const MAX_LCS_TOKENS = 300;

/**
 * Longest common subsequence of two token lists, as matched index pairs in order.
 * Returns null when either side is too long.
 */
export function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  if (n > MAX_LCS_TOKENS || m > MAX_LCS_TOKENS) return null;
  // lengths[i][j] = LCS of a[i..] and b[j..], flattened.
  const width = m + 1;
  const lengths = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j] ? lengths[(i + 1) * width + j + 1]! + 1 : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export interface WordPart {
  text: string;
  /** Removed (on the before side) or added (on the after side). */
  changed: boolean;
}

function toParts(tokens: readonly string[], matched: Uint8Array): WordPart[] {
  const changed = tokens.map((_, index) => !matched[index]);
  // Spaces between two changed words belong to the change ("Out of" reads as one phrase).
  tokens.forEach((token, index) => {
    if (!isWord(token) && index > 0 && index < tokens.length - 1 && changed[index - 1] && changed[index + 1]) changed[index] = true;
  });
  const parts: WordPart[] = [];
  tokens.forEach((token, index) => {
    const last = parts[parts.length - 1];
    if (last && last.changed === changed[index]) last.text += token;
    else parts.push({ text: token, changed: changed[index]! });
  });
  return parts;
}

/** "Out of stock" → "In stock": which words were removed and which were added. */
export function wordDiff(before: string, after: string): { before: WordPart[]; after: WordPart[] } {
  const a = tokenize(before);
  const b = tokenize(after);
  const pairs = lcsPairs(a, b);
  const matchedA = new Uint8Array(a.length);
  const matchedB = new Uint8Array(b.length);
  // Shared spaces or punctuation alone don't make two phrases "the same".
  const related = (pairs ?? []).some(([i]) => isWord(a[i]!));
  for (const [i, j] of related ? pairs! : []) {
    matchedA[i] = 1;
    matchedB[j] = 1;
  }
  return { before: toParts(a, matchedA), after: toParts(b, matchedB) };
}

/**
 * A change to a short region (one line before, one after, nothing around it): shown as a
 * large word-level "before → after" instead of a line diff. Null for anything longer.
 */
export function shortSwap(lines: readonly { type: string; text: string; ignored?: string }[]): { before: string; after: string } | null {
  if (lines.some((line) => line.ignored || line.type === 'skip' || line.type === 'context')) return null;
  const removed = lines.filter((line) => line.type === 'remove');
  const added = lines.filter((line) => line.type === 'add');
  if (removed.length !== 1 || added.length !== 1) return null;
  const before = removed[0]!.text;
  const after = added[0]!.text;
  return before.length <= 120 && after.length <= 120 ? { before, after } : null;
}
