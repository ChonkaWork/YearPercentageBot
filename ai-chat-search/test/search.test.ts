import { describe, expect, it } from 'vitest';
import { bestMessage, countOccurrences, recencyFactor, SearchIndex, type SearchDoc } from '../src/search/engine';
import { fold, foldWithMap, searchText, tokenize } from '../src/search/normalize';
import { parseQuery } from '../src/search/query';
import { highlight, makeSnippet, matchRanges, type Segment } from '../src/search/snippet';

const NOW = Date.UTC(2026, 8, 27, 12);
const DAY = 24 * 60 * 60 * 1000;

function doc(key: string, title: string, texts: string[], options: Partial<SearchDoc> = {}): SearchDoc {
  const messages = texts.map((text, index) => ({ role: index % 2 === 0 ? ('user' as const) : ('assistant' as const), text }));
  return { key, site: 'chatgpt', title, url: `https://chatgpt.com/c/${key}`, updatedAt: NOW, messages, searchText: searchText(texts), ...options };
}

const marked = (segments: Segment[]) => segments.filter((segment) => segment.match).map((segment) => segment.text);
const plain = (segments: Segment[]) => segments.map((segment) => (segment.match ? `[${segment.text}]` : segment.text)).join('');

describe('normalize', () => {
  it('folds case and diacritics', () => {
    expect(fold('Café NAÏVE Crème Brûlée Ångström')).toBe('cafe naive creme brulee angstrom');
    expect(fold('Straße Œuvre Łódź')).toBe('strasse oeuvre lodz');
  });

  it('handles Ukrainian and other Cyrillic text', () => {
    expect(fold('ПРИВІТ Україно')).toBe('привіт украіно');
    expect(fold('Їжак і йогурт, ЁЛКА')).toBe('іжак і иогурт, елка');
    // All apostrophe styles used in Ukrainian give the same word.
    expect(new Set(["м'ясо", 'м’ясо', 'мʼясо', 'М`ЯСО'].map(fold))).toEqual(new Set(['мясо']));
  });

  it('folds compatibility forms and drops invisible characters', () => {
    expect(fold('ﬁle ＡＢＣ x²')).toBe('file abc x2');
    expect(fold('soft\u00adhyphen zero\u200bwidth')).toBe('softhyphen zerowidth');
  });

  it('maps folded positions back to the original text', () => {
    const text = 'Ça va? Straße!';
    const { folded, map } = foldWithMap(text);
    expect(folded).toBe('ca va? strasse!');
    const start = folded.indexOf('strasse');
    expect(text.slice(map[start], map[start + 'strasse'.length])).toBe('Straße');
    expect(map[folded.length]).toBe(text.length);
  });

  it('keeps positions right with decomposed input and emoji', () => {
    const text = 'été 😀 café';
    const { folded, map } = foldWithMap(text);
    expect(folded).toBe('ete 😀 cafe');
    const start = folded.indexOf('cafe');
    expect(text.slice(map[start], map[start + 4])).toBe('café');
  });

  it('tokenizes words, numbers and CJK characters', () => {
    expect(tokenize(fold("Don't use snake_case, v2.5 — 中文搜索 ok"))).toEqual(['dont', 'use', 'snake', 'case', 'v2', '5', '中', '文', '搜', '索', 'ok']);
  });

  it('builds padded search text with message separators', () => {
    expect(searchText(['Hello, World!', 'Привіт'])).toBe(' hello world \n привіт ');
  });
});

describe('parseQuery', () => {
  it('splits words, phrases and multi-token words', () => {
    expect(parseQuery('Regex "sort by key" snake_case')).toEqual([
      { kind: 'word', tokens: ['regex'], needle: ' regex' },
      { kind: 'phrase', tokens: ['sort', 'by', 'key'], needle: ' sort by key ' },
      { kind: 'sequence', tokens: ['snake', 'case'], needle: ' snake case' },
    ]);
  });

  it('accepts typographic quotes and an unclosed quote', () => {
    expect(parseQuery('“Львів” «кава»').map((clause) => clause.kind)).toEqual(['phrase', 'phrase']);
    expect(parseQuery('"open phrase').at(0)?.needle).toBe(' open phrase ');
  });

  it('ignores punctuation-only input and duplicates', () => {
    expect(parseQuery('  -- ... !!')).toEqual([]);
    expect(parseQuery('python Python PYTHON')).toHaveLength(1);
  });
});

describe('SearchIndex', () => {
  const docs = [
    doc('title-match', 'Python sorting tricks', ['How to order things?', 'Use a key function.'], { updatedAt: NOW - 40 * DAY }),
    doc('body-many', 'Weekend plans', ['python python python', 'More python here, and python again.'], { updatedAt: NOW - 40 * DAY }),
    doc('body-once-old', 'Old notes', ['I once used python for scripts.'], { updatedAt: NOW - 200 * DAY }),
    doc('body-once-new', 'New notes', ['I once used python for scripts.'], { updatedAt: NOW - 1 * DAY }),
    doc('claude', 'Rust ownership', ['Explain borrowing in Rust.', 'The borrow checker…'], { site: 'claude' }),
    doc('lviv', 'Поїздка до Львова', ['Сплануй поїздку до Львова', 'Кава у «Львівській копальні кави»'], { updatedAt: NOW - 3 * DAY }),
    doc('cafe', 'Paris', ['Best café near the Louvre? Naïve question.'], { updatedAt: NOW - 3 * DAY }),
    doc('cjk', '中文', ['我想学习中文搜索引擎'], { updatedAt: NOW - 3 * DAY }),
  ];
  const index = new SearchIndex(docs);
  const keys = (query: string, site?: 'chatgpt' | 'claude') => index.search(query, { now: NOW, ...(site ? { site } : {}) }).results.map((result) => result.doc.key);

  it('ranks title matches first, then frequency, then recency', () => {
    expect(keys('python')).toEqual(['title-match', 'body-many', 'body-once-new', 'body-once-old']);
  });

  it('requires every word (AND) and matches prefixes', () => {
    expect(keys('pyth scrip')).toEqual(['body-once-new', 'body-once-old']);
    expect(keys('python rust')).toEqual([]);
  });

  it('matches exact phrases only in order', () => {
    expect(keys('"key function"')).toEqual(['title-match']);
    expect(keys('"function key"')).toEqual([]);
    // A quoted phrase needs whole words; a bare word may be a prefix.
    expect(keys('"key func"')).toEqual([]);
    expect(keys('func')).toEqual(['title-match']);
  });

  it('is case- and diacritics-insensitive, in Latin and Cyrillic', () => {
    expect(keys('CAFE naive')).toEqual(['cafe']);
    expect(keys('львів')).toEqual(['lviv']);
    expect(keys('ЛЬВІВСЬКІЙ')).toEqual(['lviv']);
    expect(keys('"копальні кави"')).toEqual(['lviv']);
  });

  it('finds CJK text inside sentences', () => {
    expect(keys('中文搜索')).toEqual(['cjk']);
    expect(keys('搜索引')).toEqual(['cjk']);
  });

  it('filters by site', () => {
    expect(keys('borrow', 'claude')).toEqual(['claude']);
    expect(keys('borrow', 'chatgpt')).toEqual([]);
    expect(keys('', 'claude')).toEqual(['claude']);
  });

  it('lists everything newest first for an empty query', () => {
    const all = keys('');
    expect(all).toHaveLength(docs.length);
    expect(all.at(-1)).toBe('body-once-old');
  });

  it('does not match across messages', () => {
    const split = new SearchIndex([doc('split', 'x', ['ends with alpha', 'beta starts here'])]);
    expect(split.search('"alpha beta"').results).toEqual([]);
    expect(split.search('alpha beta').results).toHaveLength(1);
  });

  it('reports the time taken', () => {
    expect(index.search('python').took).toBeGreaterThanOrEqual(0);
  });

  it('picks the message that matches best for the snippet', () => {
    const conversation = doc('m', 't', ['nothing here', 'sort only', 'sort by key here']);
    expect(bestMessage(conversation, parseQuery('sort key'))).toBe(2);
    expect(bestMessage(conversation, parseQuery('zzz'))).toBe(-1);
  });

  it('weights recency with a 30-day half-life', () => {
    expect(recencyFactor(NOW, NOW)).toBeCloseTo(1.5);
    expect(recencyFactor(NOW - 30 * DAY, NOW)).toBeCloseTo(1.25);
    expect(recencyFactor(NOW - 3650 * DAY, NOW)).toBeCloseTo(1);
  });

  it('counts occurrences up to a limit', () => {
    expect(countOccurrences(' a a a a ', ' a', 3)).toBe(3);
    expect(countOccurrences(' aaa ', ' aa', 10)).toBe(1);
  });
});

describe('snippets and highlighting', () => {
  it('highlights prefix matches as whole words, in the original text', () => {
    expect(plain(highlight('Sorting in Python', parseQuery('pyth sort')))).toBe('[Sorting] in [Python]');
  });

  it('highlights despite case, diacritics and apostrophes', () => {
    expect(marked(highlight('Кава у «Львівській копальні кави»', parseQuery('ЛЬВІВСЬКІЙ')))).toEqual(['Львівській']);
    expect(marked(highlight('Best CAFÉ in town', parseQuery('cafe')))).toEqual(['CAFÉ']);
    expect(marked(highlight('Замовив м’ясо', parseQuery("м'ясо")))).toEqual(['м’ясо']);
  });

  it('highlights a phrase as one range', () => {
    expect(plain(highlight('use a key function, a key', parseQuery('"key function"')))).toBe('use a [key function], a key');
  });

  it('cuts a window around the matches with ellipses and collapsed whitespace', () => {
    const text = `${'lorem ipsum '.repeat(40)}the needle\n\nis here ${'dolor sit '.repeat(40)}`;
    const segments = makeSnippet(text, parseQuery('needle'), 80);
    const joined = segments.map((segment) => segment.text).join('');
    expect(segments[0]?.text).toBe('…');
    expect(segments.at(-1)?.text).toBe('…');
    expect(marked(segments)).toEqual(['needle']);
    expect(joined).toContain('the needle is here');
    expect(joined.length).toBeLessThanOrEqual(84);
  });

  it('starts at the beginning when there is no match', () => {
    expect(plain(makeSnippet('short text', parseQuery('zzz')))).toBe('short text');
  });

  it('prefers the window with the most matches', () => {
    const text = `alpha ${'x '.repeat(200)} beta alpha beta`;
    const segments = makeSnippet(text, parseQuery('alpha beta'), 40);
    expect(marked(segments)).toEqual(['beta', 'alpha', 'beta']);
  });

  it('never splits surrogate pairs or loses characters around matches', () => {
    const text = '😀 find me 😀';
    expect(plain(highlight(text, parseQuery('find')))).toBe('😀 [find] me 😀');
    expect(matchRanges(text, parseQuery('me'))).toEqual([{ start: 8, end: 10 }]);
  });
});
