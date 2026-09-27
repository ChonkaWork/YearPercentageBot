import { describe, expect, it } from 'vitest';
import { buildIndex, findAllShadowed, findMatch, findShadowing, mayCompleteAbbreviation } from '../src/core/matcher';

const index = buildIndex([
  { abbreviation: ';sig', id: 'sig' },
  { abbreviation: ';s', id: 's' },
  { abbreviation: 'brb', id: 'brb' },
  { abbreviation: 'x;sig', id: 'xsig' },
  { abbreviation: ':🙂', id: 'emoji' },
  { abbreviation: 'ßx', id: 'eszett' },
]);

const match = (text: string) => findMatch(text, index)?.item.id ?? null;

describe('buildIndex', () => {
  it('collects lengths longest first, last characters and the max length', () => {
    expect(index.lengths).toEqual([5, 4, 3, 2]);
    expect(index.maxLength).toBe(5);
    expect(index.size).toBe(6);
    expect(mayCompleteAbbreviation(index, 'g')).toBe(true);
    expect(mayCompleteAbbreviation(index, 'q')).toBe(false);
    expect(mayCompleteAbbreviation(index, '')).toBe(false);
    expect(mayCompleteAbbreviation(index, null)).toBe(false);
  });

  it('keeps the first of duplicate abbreviations', () => {
    const duplicate = buildIndex([
      { abbreviation: 'aa', id: 1 },
      { abbreviation: 'aa', id: 2 },
    ]);
    expect(duplicate.size).toBe(1);
    expect(findMatch('aa', duplicate)?.item.id).toBe(1);
  });
});

describe('findMatch', () => {
  it('matches an abbreviation right before the caret', () => {
    expect(match(';sig')).toBe('sig');
    expect(match('Hello ;sig')).toBe('sig');
    expect(match(';si')).toBe(null);
    expect(match(';sig ')).toBe(null);
  });

  it('prefers the longest abbreviation', () => {
    expect(match('x;sig')).toBe('xsig');
    expect(match(' ;s')).toBe('s');
  });

  it('expands symbol-prefixed abbreviations anywhere', () => {
    expect(match('word;sig')).toBe('sig');
  });

  it('expands word abbreviations only at the start of a word', () => {
    expect(match('brb')).toBe('brb');
    expect(match('ok brb')).toBe('brb');
    expect(match('(brb')).toBe('brb');
    expect(match('\nbrb')).toBe('brb');
    expect(match('xbrb')).toBe(null);
    expect(match('1brb')).toBe(null);
    expect(match('ébrb')).toBe(null);
    expect(match('Ωbrb')).toBe(null);
  });

  it('handles non-BMP characters', () => {
    expect(match('hi :🙂')).toBe('emoji');
    expect(match('ßx')).toBe('eszett');
    // A letter outside the BMP before a word abbreviation still counts as part of the word.
    expect(match('𝐀ßx')).toBe(null);
  });

  it('returns null for an empty index or empty text', () => {
    expect(findMatch('anything', buildIndex([]))).toBe(null);
    expect(match('')).toBe(null);
  });

  it('is case-sensitive', () => {
    expect(match(';SIG')).toBe(null);
  });
});

describe('shadowing in "as you type" mode', () => {
  it('finds the abbreviation that fires first', () => {
    const shadowIndex = buildIndex([{ abbreviation: ';s' }, { abbreviation: ';sig' }, { abbreviation: ';ty' }, { abbreviation: 'sig' }]);
    expect(findShadowing(';sig', shadowIndex)).toBe(';s');
    expect(findShadowing(';ty', shadowIndex)).toBe(null);
    expect(findShadowing(';s', shadowIndex)).toBe(null);
  });

  it('respects word boundaries inside longer abbreviations', () => {
    // "sig" starts a word after ";" and fires before ";sigx" is complete...
    expect(findAllShadowed(['sig', ';sigx']).get(';sigx')).toBe('sig');
    // ...but not in the middle of "xsigy".
    expect(findAllShadowed(['sig', 'xsigy']).has('xsigy')).toBe(false);
  });

  it('reports nothing for independent abbreviations', () => {
    expect(findAllShadowed([';sig', ';addr', ';ty', ';date', ';meet', ';shrug']).size).toBe(0);
  });
});

describe('performance', () => {
  it('handles thousands of snippets per keystroke quickly', () => {
    const big = buildIndex(Array.from({ length: 2000 }, (_, i) => ({ abbreviation: `;s${i}` })));
    const text = 'x'.repeat(40);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) findMatch(`${text};s${i % 2500}`, big);
    const perCall = (performance.now() - started) / 20_000;
    expect(perCall).toBeLessThan(0.05);
  });
});
