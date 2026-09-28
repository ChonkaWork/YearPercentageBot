import { cleanPageUrl } from './pageLink';

/**
 * "Quote with a deep link": a Text Fragment (https://wicg.github.io/scroll-to-text-fragment/)
 * that makes the browser scroll to and highlight exactly the quoted passage:
 *
 *   https://example.com/post#:~:text=[prefix-,]textStart[,textEnd][,-suffix]
 *
 * Pure. The page (src/page/pageText.ts) supplies the page's visible text the way find-in-page
 * sees it, with the selection's offsets; this module picks the shortest directive the browser
 * resolves to that exact passage and nowhere earlier on the page.
 *
 * How browsers match (per the spec, and Chrome's implementation of it):
 * - each term matches inside one block (paragraph, list item, cell...), case-insensitively,
 *   and must start and/or end on a word boundary;
 * - the prefix may end in the previous block: only whitespace may separate it from textStart,
 *   and only whitespace may separate textEnd (or textStart) from the suffix;
 * - the first match in document order wins.
 *
 * Uniqueness is checked with a slightly looser matcher than the browser's (accents and case
 * folded, every non-letter treated as a word boundary): it finds every match the browser
 * finds and a few more, so a directive it accepts can't resolve to an earlier passage.
 */

/** The page's visible text: whitespace collapsed, blocks separated by "\n", with the selection. */
export interface PageTextModel {
  text: string;
  /** Selection offsets in `text` (end exclusive). */
  start: number;
  end: number;
}

export interface TextDirective {
  prefix?: string;
  textStart: string;
  textEnd?: string;
  suffix?: string;
}

export type FragmentResult =
  | { status: 'ok'; directive: TextDirective; fragment: string }
  /** Nothing linkable was selected (only whitespace or punctuation). */
  | { status: 'empty' }
  /** The passage repeats with the same surroundings: no directive would find this copy first. */
  | { status: 'ambiguous' };

/** Selections up to this long (within one block) are quoted in full as textStart. */
export const EXACT_MAX_CHARS = 100;
const RANGE_WORDS = [3, 5, 8, 12];
const CONTEXT_WORDS = [0, 1, 2, 3, 5, 8];
/** Guard against pathological pages (a term repeated thousands of times): give up, stay safe. */
const MAX_CANDIDATES = 5000;

const SPACE = /[\s ]/;

// --- Words ---------------------------------------------------------------------------------

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

interface Word {
  start: number;
  end: number;
}

/** Word-like segments of one block, with offsets relative to the whole text. */
function wordsOf(text: string, blockStart: number, blockEnd: number): Word[] {
  const block = text.slice(blockStart, blockEnd);
  const words: Word[] = [];
  if (segmenter) {
    for (const segment of segmenter.segment(block)) {
      if (segment.isWordLike) words.push({ start: blockStart + segment.index, end: blockStart + segment.index + segment.segment.length });
    }
    return words;
  }
  for (const match of block.matchAll(/[\p{L}\p{N}_'’]+/gu)) {
    words.push({ start: blockStart + (match.index ?? 0), end: blockStart + (match.index ?? 0) + match[0].length });
  }
  return words;
}

function blockStartOf(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

function blockEndOf(text: string, index: number): number {
  const next = text.indexOf('\n', index);
  return next === -1 ? text.length : next;
}

/** Moves the selection out to whole words: browsers only match terms on word boundaries. */
export function snapToWords(text: string, start: number, end: number): { start: number; end: number } {
  const startBlock = blockStartOf(text, start);
  const inStart = wordsOf(text, startBlock, blockEndOf(text, start)).find((word) => word.start < start && start < word.end);
  const endBlock = blockStartOf(text, Math.max(start, end - 1));
  const inEnd = wordsOf(text, endBlock, blockEndOf(text, endBlock)).find((word) => word.start < end && end < word.end);
  return { start: inStart ? inStart.start : start, end: inEnd ? inEnd.end : end };
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  while (s < e && SPACE.test(text[s] ?? '')) s++;
  while (e > s && SPACE.test(text[e - 1] ?? '')) e--;
  return { start: s, end: e };
}

// --- Matching (the browser's algorithm, with a looser comparison) -----------------------------

const QUOTES: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"' };

/**
 * Case and accent folding that keeps every index where it was: characters whose folded form
 * has another length are left alone. Curly quotes fold to straight ones.
 */
export function foldForMatch(value: string): string {
  let out = '';
  for (const ch of value) {
    const quote = QUOTES[ch];
    if (quote) {
      out += quote;
      continue;
    }
    const folded = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    if (folded.length === ch.length) out += folded;
    else {
      const lower = ch.toLowerCase();
      out += lower.length === ch.length ? lower : ch;
    }
  }
  return out;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
/** Scripts written without spaces: a word boundary can fall between any two letters. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** True wherever a browser might see a word boundary (never false where it does). */
function mayBeBoundary(text: string, index: number): boolean {
  const before = text[index - 1];
  const after = text[index];
  if (before === undefined || after === undefined) return true;
  if (!WORD_CHAR.test(before) || !WORD_CHAR.test(after)) return true;
  return UNSPACED.test(before) || UNSPACED.test(after);
}

interface Budget {
  left: number;
}

function findTerm(hay: string, term: string, from: number, startBounded: boolean, endBounded: boolean, budget: Budget): number {
  let index = hay.indexOf(term, from);
  while (index !== -1) {
    if (--budget.left < 0) return -1;
    if ((!startBounded || mayBeBoundary(hay, index)) && (!endBounded || mayBeBoundary(hay, index + term.length))) return index;
    index = hay.indexOf(term, index + 1);
  }
  return -1;
}

function skipSpace(hay: string, index: number): number {
  let i = index;
  while (i < hay.length && SPACE.test(hay[i] ?? '')) i++;
  return i;
}

function startsAt(hay: string, term: string, index: number, endBounded: boolean): boolean {
  return hay.startsWith(term, index) && (!endBounded || mayBeBoundary(hay, index + term.length));
}

/**
 * Where a browser would land for this directive: the first match in document order, as
 * offsets into `text`. `null` when nothing matches (or the page is too repetitive to tell).
 * Exported for tests.
 */
export function resolveDirective(text: string, directive: TextDirective): { start: number; end: number } | null {
  const hay = foldForMatch(text);
  const prefix = directive.prefix === undefined ? undefined : foldForMatch(directive.prefix);
  const start = foldForMatch(directive.textStart);
  const end = directive.textEnd === undefined ? undefined : foldForMatch(directive.textEnd);
  const suffix = directive.suffix === undefined ? undefined : foldForMatch(directive.suffix);
  const budget: Budget = { left: MAX_CANDIDATES };
  const startEndBounded = end !== undefined || suffix === undefined;

  let searchFrom = 0;
  for (;;) {
    let matchStart: number;
    if (prefix !== undefined) {
      const prefixAt = findTerm(hay, prefix, searchFrom, true, false, budget);
      if (prefixAt === -1) return null;
      searchFrom = prefixAt + 1;
      const candidate = skipSpace(hay, prefixAt + prefix.length);
      if (!startsAt(hay, start, candidate, startEndBounded)) continue;
      matchStart = candidate;
    } else {
      matchStart = findTerm(hay, start, searchFrom, true, startEndBounded, budget);
      if (matchStart === -1) return null;
      searchFrom = matchStart + 1;
    }

    let matchEnd = matchStart + start.length;
    if (end === undefined) {
      if (suffix === undefined || startsAt(hay, suffix, skipSpace(hay, matchEnd), true)) return { start: matchStart, end: matchEnd };
      continue;
    }
    // textEnd: the first occurrence after textStart (followed by the suffix, if there is one).
    let endFrom = matchEnd;
    for (;;) {
      const endAt = findTerm(hay, end, endFrom, true, suffix === undefined, budget);
      if (endAt === -1) return null;
      matchEnd = endAt + end.length;
      if (suffix === undefined || startsAt(hay, suffix, skipSpace(hay, matchEnd), true)) return { start: matchStart, end: matchEnd };
      endFrom = matchEnd;
    }
  }
}

// --- Building ------------------------------------------------------------------------------

/** Percent-encodes a term: `-`, `,` and `&` are directive syntax; parentheses would break Markdown links. */
export function encodeTerm(term: string): string {
  return encodeURIComponent(term).replace(/[-()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `text=prefix-,start,end,-suffix`, every part percent-encoded. */
export function formatDirective(directive: TextDirective): string {
  let value = '';
  if (directive.prefix !== undefined) value += `${encodeTerm(directive.prefix)}-,`;
  value += encodeTerm(directive.textStart);
  if (directive.textEnd !== undefined) value += `,${encodeTerm(directive.textEnd)}`;
  if (directive.suffix !== undefined) value += `,-${encodeTerm(directive.suffix)}`;
  return `text=${value}`;
}

/** The last `count` words before `index`: in its own block, or at the end of the previous one. */
function prefixBefore(text: string, index: number, count: number): string | undefined {
  let blockStart = blockStartOf(text, index);
  let limit = index;
  if (!text.slice(blockStart, index).trim()) {
    // The selection starts its block: take the context from the end of the previous block.
    if (blockStart === 0) return undefined;
    limit = blockStart - 1;
    blockStart = blockStartOf(text, limit);
  }
  const words = wordsOf(text, blockStart, limit);
  if (words.length === 0) return undefined;
  const first = words[Math.max(0, words.length - count)];
  const value = text.slice(first?.start ?? blockStart, limit).trimEnd();
  return value || undefined;
}

/** The first `count` words after `index`: in its own block, or at the start of the next one. */
function suffixAfter(text: string, index: number, count: number): string | undefined {
  let from = index;
  let blockEnd = blockEndOf(text, index);
  if (!text.slice(index, blockEnd).trim()) {
    if (blockEnd >= text.length) return undefined;
    from = blockEnd + 1;
    blockEnd = blockEndOf(text, from);
  }
  const words = wordsOf(text, from, blockEnd);
  if (words.length === 0) return undefined;
  const last = words[Math.min(words.length, count) - 1];
  const value = text.slice(from, last?.end ?? blockEnd).trimStart();
  return value || undefined;
}

interface Terms {
  textStart: string;
  textEnd?: string;
}

/** textStart/textEnd for a passage: the whole passage when short, otherwise its first and last words. */
function rangeTerms(text: string, start: number, end: number, count: number): Terms | null {
  const firstBlockEnd = Math.min(blockEndOf(text, start), end);
  const lastBlockStart = Math.max(blockStartOf(text, end), start);
  const startWords = wordsOf(text, start, firstBlockEnd);
  const endWords = wordsOf(text, lastBlockStart, end);
  const startTo = startWords[Math.min(count, startWords.length) - 1]?.end ?? firstBlockEnd;
  const endFrom = endWords[Math.max(0, endWords.length - count)]?.start ?? lastBlockStart;
  if (startTo > endFrom) return null;
  const textStart = text.slice(start, startTo).trim();
  const textEnd = text.slice(endFrom, end).trim();
  return textStart && textEnd ? { textStart, textEnd } : null;
}

/**
 * The shortest text directive that takes a browser to exactly this passage. Short passages
 * are quoted in full; long or multi-paragraph ones as their first and last words. Context
 * (prefix/suffix words) is added only when the passage, or its first words, also appear
 * earlier on the page.
 */
export function buildTextFragment(model: PageTextModel): FragmentResult {
  const text = model.text;
  const trimmed = trimRange(text, model.start, model.end);
  if (trimmed.start >= trimmed.end) return { status: 'empty' };
  const snapped = snapToWords(text, trimmed.start, trimmed.end);
  const { start, end } = trimRange(text, snapped.start, snapped.end);
  if (wordsOf(text, start, end).length === 0) return { status: 'empty' };

  const passage = text.slice(start, end);
  const exact = !passage.includes('\n') && passage.length <= EXACT_MAX_CHARS;
  const termOptions: Terms[] = [];
  if (exact) termOptions.push({ textStart: passage });
  else {
    const seen = new Set<string>();
    for (const count of RANGE_WORDS) {
      const terms = rangeTerms(text, start, end, count);
      const key = terms ? `${terms.textStart}\n${terms.textEnd}` : '';
      if (terms && !seen.has(key)) {
        seen.add(key);
        termOptions.push(terms);
      }
    }
    // A long passage with too few words for two terms (a URL, a hash): quote it whole.
    if (termOptions.length === 0 && !passage.includes('\n')) termOptions.push({ textStart: passage });
    if (termOptions.length === 0) return { status: 'ambiguous' };
  }

  for (const context of CONTEXT_WORDS) {
    const prefix = context ? prefixBefore(text, start, context) : undefined;
    const suffix = context ? suffixAfter(text, end, context) : undefined;
    const contexts: { prefix?: string; suffix?: string }[] =
      context === 0 ? [{}] : [{ prefix }, { suffix }, { prefix, suffix }].filter((item) => item.prefix !== undefined || item.suffix !== undefined);
    for (const around of contexts) {
      for (const terms of termOptions) {
        const directive: TextDirective = { ...terms };
        if (around.prefix !== undefined) directive.prefix = around.prefix;
        if (around.suffix !== undefined) directive.suffix = around.suffix;
        const found = resolveDirective(text, directive);
        if (found && found.start === start && found.end === end) {
          return { status: 'ok', directive: ordered(directive), fragment: formatDirective(directive) };
        }
      }
    }
  }
  return { status: 'ambiguous' };
}

function ordered(directive: TextDirective): TextDirective {
  const out: TextDirective = { textStart: directive.textStart };
  if (directive.prefix !== undefined) out.prefix = directive.prefix;
  if (directive.textEnd !== undefined) out.textEnd = directive.textEnd;
  if (directive.suffix !== undefined) out.suffix = directive.suffix;
  return out;
}

// --- URLs ----------------------------------------------------------------------------------

/**
 * The page address a quote links to: http(s) only, tracking parameters removed, and any
 * existing fragment dropped (an old `:~:text=` directive, or an in-page `#anchor` that the
 * text fragment replaces). Hash routes of single-page apps (`#/inbox`, `#!/post`) are part
 * of the page's address and are kept.
 */
export function quoteBaseUrl(raw: string | null | undefined): string | null {
  const url = cleanPageUrl(raw);
  if (!url) return null;
  const hashAt = url.indexOf('#');
  if (hashAt === -1) return url;
  const base = url.slice(0, hashAt);
  const hash = url.slice(hashAt + 1).split(':~:')[0] ?? '';
  return /^!?\//.test(hash) ? `${base}#${hash}` : base;
}

/** Appends a text directive (`text=...`) to a base URL from `quoteBaseUrl`. */
export function withTextFragment(baseUrl: string, fragment: string | null): string {
  if (!fragment) return baseUrl;
  return baseUrl.includes('#') ? `${baseUrl}:~:${fragment}` : `${baseUrl}#:~:${fragment}`;
}
