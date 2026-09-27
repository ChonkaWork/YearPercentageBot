/**
 * Finds the abbreviation that ends at the caret. Built for the keystroke hot path: one Map
 * lookup per distinct abbreviation length, and a Set check that rejects most keystrokes
 * before any text is read from the page.
 */

export interface AbbreviationIndex<T> {
  readonly map: ReadonlyMap<string, T>;
  /** Distinct abbreviation lengths (UTF-16 units), longest first so the longest match wins. */
  readonly lengths: readonly number[];
  /** Last UTF-16 unit of every abbreviation. A typed character not in here can't complete one. */
  readonly lastChars: ReadonlySet<string>;
  /** Longest abbreviation (UTF-16 units). Callers read at most `maxLength + 1` characters. */
  readonly maxLength: number;
  readonly size: number;
}

export interface Match<T> {
  item: T;
  abbreviation: string;
}

export function buildIndex<T extends { abbreviation: string }>(items: readonly T[]): AbbreviationIndex<T> {
  const map = new Map<string, T>();
  const lengths = new Set<number>();
  const lastChars = new Set<string>();
  for (const item of items) {
    const abbreviation = item.abbreviation;
    if (!abbreviation || map.has(abbreviation)) continue;
    map.set(abbreviation, item);
    lengths.add(abbreviation.length);
    lastChars.add(abbreviation[abbreviation.length - 1] as string);
  }
  const sortedLengths = [...lengths].sort((a, b) => b - a);
  return { map, lengths: sortedLengths, lastChars, maxLength: sortedLengths[0] ?? 0, size: map.size };
}

/** Cheap pre-check on the typed text (e.g. `InputEvent.data`). */
export function mayCompleteAbbreviation(index: AbbreviationIndex<unknown>, typed: string | null | undefined): boolean {
  return !!typed && index.lastChars.has(typed[typed.length - 1] as string);
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

export function isWordChar(char: string): boolean {
  return char !== '' && WORD_CHAR.test(char);
}

/** The code point that ends right before `position` (handles surrogate pairs). */
function charBefore(text: string, position: number): string {
  if (position <= 0) return '';
  const low = text.charCodeAt(position - 1);
  if (low >= 0xdc00 && low <= 0xdfff && position >= 2) {
    const high = text.charCodeAt(position - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(position - 2, position);
  }
  return text.charAt(position - 1);
}

function firstChar(text: string): string {
  return String.fromCodePoint(text.codePointAt(0) ?? 0);
}

/**
 * `textBefore` is the text right before the caret: the whole field or text node, or its last
 * `maxLength + 1` characters. When the abbreviation is the entire string, it counts as being
 * at the start of the field.
 *
 * An abbreviation that starts with a letter or digit (`sig`) only expands at the start of a
 * word, so it doesn't fire inside `design`. One that starts with a symbol (`;sig`) expands
 * anywhere.
 */
export function findMatch<T>(textBefore: string, index: AbbreviationIndex<T>): Match<T> | null {
  if (index.size === 0 || textBefore === '') return null;
  if (!index.lastChars.has(textBefore[textBefore.length - 1] as string)) return null;
  for (const length of index.lengths) {
    if (length > textBefore.length) continue;
    const start = textBefore.length - length;
    const candidate = textBefore.slice(start);
    const item = index.map.get(candidate);
    if (item === undefined) continue;
    if (isWordChar(firstChar(candidate)) && isWordChar(charBefore(textBefore, start))) continue;
    return { item, abbreviation: candidate };
  }
  return null;
}

/**
 * In "as you type" mode an abbreviation can be unreachable: while typing `;sig2`, `;sig`
 * expands first. Returns the abbreviation that fires first, or null.
 */
export function findShadowing<T>(abbreviation: string, index: AbbreviationIndex<T>): string | null {
  for (let end = 1; end < abbreviation.length; end++) {
    const match = findMatch(abbreviation.slice(0, end), index);
    if (match) return match.abbreviation;
  }
  return null;
}

/** Map of abbreviation → the abbreviation that makes it unreachable in "as you type" mode. */
export function findAllShadowed(abbreviations: readonly string[]): Map<string, string> {
  const index = buildIndex(abbreviations.map((abbreviation) => ({ abbreviation })));
  const shadowed = new Map<string, string>();
  for (const abbreviation of abbreviations) {
    const by = findShadowing(abbreviation, index);
    if (by) shadowed.set(abbreviation, by);
  }
  return shadowed;
}
