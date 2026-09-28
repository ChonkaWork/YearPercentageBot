import { describe, expect, it } from 'vitest';
import { countWords, estimateTokens, htmlWords } from '../src/core/stats';

describe('stats', () => {
  it('counts words, not punctuation or Markdown syntax', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('  \n ')).toBe(0);
    expect(countWords('Night trains return to Central Europe.')).toBe(6);
    expect(countWords('> **Bold** claim — [link](https://example.com) - 42')).toBeGreaterThanOrEqual(4);
    expect(countWords("don't stop")).toBe(2);
  });

  it('counts words in languages without spaces', () => {
    expect(countWords('東京は日本の首都です')).toBeGreaterThan(3);
    expect(countWords('Київ — столиця України')).toBe(3);
  });

  it('estimates tokens as characters ÷ 4, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('counts words of HTML without the tags', () => {
    expect(htmlWords('<p>Hello <strong class="x">world</strong>&nbsp;again</p>')).toBe(3);
  });

  it('stays fast on very long text', () => {
    const text = 'word '.repeat(300_000);
    const started = performance.now();
    expect(countWords(text)).toBe(300_000);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
