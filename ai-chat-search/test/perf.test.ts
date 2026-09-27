import { describe, expect, it } from 'vitest';
import { SearchIndex, type SearchDoc } from '../src/search/engine';
import { searchText } from '../src/search/normalize';

/**
 * 1,000 synthetic conversations of ~15 KB of text each (15 MB), mixing English, Ukrainian and
 * code-like tokens from a large vocabulary, like a heavy user's history. Every query must finish
 * in under 100 ms.
 */

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const next = random(42);
const SYLLABLES = ['ka', 'ro', 'mi', 'te', 'lu', 'po', 'na', 'shi', 'ver', 'dan', 'ко', 'ва', 'ні', 'ль', 'при', 'ст', 'ор', 'ін', 'ща'];
const vocabulary = Array.from({ length: 30_000 }, () => {
  let word = '';
  const parts = 2 + Math.floor(next() * 3);
  for (let i = 0; i < parts; i++) word += SYLLABLES[Math.floor(next() * SYLLABLES.length)];
  return word;
});
const COMMON = ['the', 'and', 'python', 'function', 'що', 'це', 'data', 'value', 'error', 'import'];

function sentence(words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(next() < 0.3 ? (COMMON[Math.floor(next() * COMMON.length)] ?? 'the') : (vocabulary[Math.floor(next() * vocabulary.length)] ?? 'x'));
  }
  return `${out.join(' ')}.`;
}

function makeDocs(count: number): SearchDoc[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const texts = Array.from({ length: 16 }, () => sentence(130));
    if (index % 97 === 0) texts.push('The quick brown fox jumps over the lazy dog near Львів.');
    return {
      key: `chatgpt:${index}`,
      site: index % 3 === 0 ? 'claude' : 'chatgpt',
      title: sentence(4),
      url: `https://chatgpt.com/c/${index}`,
      updatedAt: now - index * 3_600_000,
      messages: texts.map((text, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text })),
      searchText: searchText(texts),
    } satisfies SearchDoc;
  });
}

describe('search performance', () => {
  const docs = makeDocs(1000);
  const totalChars = docs.reduce((sum, doc) => sum + doc.searchText.length, 0);
  const index = new SearchIndex(docs);

  const queries = ['python', 'function error', 'kamite', '"quick brown fox"', 'львів', 'zzzz nothing', 'ko', 'the and python data value'];

  it(`answers every query over ${docs.length} conversations in under 100 ms`, () => {
    expect(totalChars).toBeGreaterThan(12_000_000);
    index.search('warm up');
    const timings: Record<string, number> = {};
    for (const query of queries) {
      // Median of three runs: robust against a single GC pause on a shared machine.
      const runs = [0, 1, 2].map(() => index.search(query).took).sort((a, b) => a - b);
      timings[query] = Math.round((runs[1] ?? 0) * 10) / 10;
    }
    console.log(`search over ${(totalChars / 1e6).toFixed(1)} M chars (ms):`, timings);
    for (const [query, took] of Object.entries(timings)) expect(took, query).toBeLessThan(100);
  });

  it('finds the planted phrase in the right conversations', () => {
    const { results } = index.search('"quick brown fox" львів');
    expect(results.map((result) => result.doc.key).sort()).toEqual(
      docs.filter((_, i) => i % 97 === 0).map((doc) => doc.key).sort(),
    );
  });
});
