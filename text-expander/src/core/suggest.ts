/**
 * Inline suggestions: while the user types something that starts like one of their
 * abbreviations (`;me`), list the snippets it could be. Pure matching and ranking; the
 * content script reads the text before the caret and draws the list.
 *
 * Suggestions start at a trigger character: the first character of an abbreviation when it
 * isn't a letter or digit (`;` in `;sig`, `/` in `/todo`). Letters-only abbreviations never
 * open suggestions, so ordinary typing never does.
 */

import { isWordChar } from './matcher';
import type { UsageMap } from './usage';

/** Longest text (UTF-16 units) before the caret that can be a query. */
export const MAX_QUERY = 40;
/** At most this many suggestions are listed (about six are visible at a time). */
export const MAX_SUGGESTIONS = 30;

/** The first character of every abbreviation that starts with a symbol. */
export function triggerChars(abbreviations: Iterable<string>): Set<string> {
  const triggers = new Set<string>();
  for (const abbreviation of abbreviations) {
    const first = String.fromCodePoint(abbreviation.codePointAt(0) ?? 0);
    if (abbreviation && !isWordChar(first) && !/\s/u.test(first)) triggers.add(first);
  }
  return triggers;
}

/** True when `text` (e.g. `InputEvent.data`) contains a trigger character. */
export function hasTrigger(text: string | null | undefined, triggers: ReadonlySet<string>): boolean {
  if (!text || triggers.size === 0) return false;
  for (const char of text) if (triggers.has(char)) return true;
  return false;
}

export interface QueryCandidate {
  /** From a trigger character to the caret, e.g. `;me`. */
  text: string;
  /** Where it starts in the text that was searched. */
  start: number;
  /** Preceded by whitespace or the start of the field (not in the middle of a word). */
  wordStart: boolean;
}

/**
 * The possible queries ending at the caret, longest first: every suffix of the current word
 * (the run of non-space characters before the caret) that starts with a trigger character.
 * `textBefore` is the text before the caret; `complete` says whether it starts at the
 * beginning of the field (otherwise its first character only tells what precedes the rest).
 */
export function queryCandidates(textBefore: string, triggers: ReadonlySet<string>, complete: boolean): QueryCandidate[] {
  if (triggers.size === 0 || textBefore === '') return [];
  let wordStart = textBefore.length;
  while (wordStart > 0 && !/\s/u.test(textBefore.charAt(wordStart - 1))) wordStart--;
  const from = Math.max(wordStart, textBefore.length - MAX_QUERY, complete ? 0 : 1);
  const candidates: QueryCandidate[] = [];
  for (let index = from; index < textBefore.length; index++) {
    const code = textBefore.codePointAt(index) ?? 0;
    if (code >= 0xdc00 && code <= 0xdfff) continue; // second half of a surrogate pair
    if (!triggers.has(String.fromCodePoint(code))) continue;
    candidates.push({ text: textBefore.slice(index), start: index, wordStart: index === wordStart && (index > 0 || complete) });
  }
  return candidates;
}

export interface Suggestible {
  id: string;
  abbreviation: string;
  label: string;
}

export interface Suggestion<T> {
  item: T;
  /** What matched: the abbreviation starts with the query, or a word of the label does. */
  by: 'abbreviation' | 'name';
}

export interface SuggestResult<T> {
  query: QueryCandidate;
  suggestions: Suggestion<T>[];
}

const LEADING_SYMBOLS = /^[^\p{L}\p{N}\p{M}_]+/u;
// Apostrophes stay inside words: "Today's" is one word, not "today" and "s".
const WORD_SPLIT = /[^\p{L}\p{N}\p{M}_'’]+/u;
/** A label match needs at least this many letters; one letter would match half the library. */
const MIN_NAME_QUERY = 2;
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Ranks the snippets for one query: the exact abbreviation first, then abbreviations that
 * start with the query (case-sensitive before case-insensitive), then snippets whose label
 * has a word starting with the query's letters (`;thank` finds "Thanks"; two letters at
 * least). Within a group the most used come first, then alphabetical.
 *
 * In the middle of a word (`word;me`) only abbreviations count, and a lone symbol (`;`) lists
 * everything only at the start of a word, so ordinary punctuation doesn't open a list.
 */
export function rankSuggestions<T extends Suggestible>(items: readonly T[], query: QueryCandidate, usage: UsageMap = {}): Suggestion<T>[] {
  const typed = query.text;
  const lower = typed.toLocaleLowerCase();
  const words = typed.replace(LEADING_SYMBOLS, '').toLocaleLowerCase();
  if (!words && !query.wordStart) return [];
  const ranked: { item: T; rank: number; by: Suggestion<T>['by'] }[] = [];
  for (const item of items) {
    const abbreviation = item.abbreviation;
    let rank = -1;
    if (abbreviation === typed) rank = 0;
    else if (abbreviation.startsWith(typed)) rank = 1;
    else if (abbreviation.toLocaleLowerCase().startsWith(lower)) rank = 2;
    if (rank >= 0) {
      ranked.push({ item, rank, by: 'abbreviation' });
      continue;
    }
    if (query.wordStart && words.length >= MIN_NAME_QUERY && item.label.toLocaleLowerCase().split(WORD_SPLIT).some((word) => word.startsWith(words))) {
      ranked.push({ item, rank: 3, by: 'name' });
    }
  }
  const count = (item: T) => usage[item.id]?.count ?? 0;
  const last = (item: T) => usage[item.id]?.lastUsed ?? 0;
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      count(b.item) - count(a.item) ||
      last(b.item) - last(a.item) ||
      collator.compare(a.item.abbreviation, b.item.abbreviation) ||
      (a.item.abbreviation < b.item.abbreviation ? -1 : 1),
  );
  return ranked.slice(0, MAX_SUGGESTIONS).map(({ item, by }) => ({ item, by }));
}

/** The longest query with at least one suggestion, or null. */
export function suggest<T extends Suggestible>(
  items: readonly T[],
  textBefore: string,
  triggers: ReadonlySet<string>,
  complete: boolean,
  usage: UsageMap = {},
): SuggestResult<T> | null {
  for (const query of queryCandidates(textBefore, triggers, complete)) {
    const suggestions = rankSuggestions(items, query, usage);
    if (suggestions.length > 0) return { query, suggestions };
  }
  return null;
}
