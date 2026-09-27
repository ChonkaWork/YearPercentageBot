/**
 * Text normalization for search: case- and diacritics-insensitive, the same for every script.
 *
 *   "Café"   → "cafe"      "ПРИВІТ" → "привіт"      "п’ять" / "п'ять" / "пʼять" → "пять"
 *
 * Folding is per character (NFKD, drop combining marks, lowercase, a few special letters), so a
 * folded string can be mapped back to the original text for highlighting. Note that for
 * Cyrillic this also folds й → и, ї → і and ё → е; queries are folded the same way, so matches
 * stay consistent.
 *
 * Tokens are runs of letters and digits. Han, Hiragana and Katakana characters are single-letter
 * tokens, so a Chinese or Japanese query matches anywhere inside a sentence (as a phrase).
 */

/** Bump when folding or tokenizing changes: stored search text is rebuilt on load. */
export const NORMALIZER_VERSION = 1;

const SPECIAL: Readonly<Record<string, string>> = {
  ß: 'ss',
  ẞ: 'ss',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ø: 'o',
  Ø: 'o',
  đ: 'd',
  Đ: 'd',
  ł: 'l',
  Ł: 'l',
  ı: 'i',
  þ: 'th',
  Þ: 'th',
};

/** Apostrophes inside words (English "don't", Ukrainian "м'ясо") and invisible characters vanish. */
const REMOVED = /^['’‘ʼ`´\u00ad\u200b-\u200d\u2060\ufeff]$/;

const cache = new Map<string, string>();

export function foldChar(char: string): string {
  const code = char.charCodeAt(0);
  if (code < 0x80) return char === "'" || char === '`' ? '' : char.toLowerCase();
  let folded = cache.get(char);
  if (folded !== undefined) return folded;
  if (REMOVED.test(char)) folded = '';
  else folded = SPECIAL[char] ?? char.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  if (cache.size < 50_000) cache.set(char, folded);
  return folded;
}

export function fold(text: string): string {
  let out = '';
  for (const char of text) out += foldChar(char);
  return out;
}

/**
 * Folds `text` and returns, for every UTF-16 unit of the folded string, the index of the
 * original character it came from. `map[folded.length]` is `text.length`.
 */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let index = 0;
  for (const char of text) {
    const part = foldChar(char);
    for (let unit = 0; unit < part.length; unit++) map.push(index);
    folded += part;
    index += char.length;
  }
  map.push(text.length);
  return { folded, map };
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}';
const TOKEN = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, 'gu');

export interface Token {
  value: string;
  start: number;
  end: number;
}

/** Tokens of an already folded string, with their positions. */
export function tokensWithOffsets(folded: string): Token[] {
  return Array.from(folded.matchAll(TOKEN), (match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

/** Tokens of an already folded string. */
export function tokenize(folded: string): string[] {
  return folded.match(TOKEN) ?? [];
}

/**
 * The searchable form of a conversation: folded tokens separated by single spaces, messages
 * separated by " \n ", padded with spaces. " term" finds a token prefix; " a b " an exact phrase,
 * which can't span two messages.
 */
export function searchText(texts: readonly string[]): string {
  return ` ${texts.map((text) => tokenize(fold(text)).join(' ')).join(' \n ')} `;
}
