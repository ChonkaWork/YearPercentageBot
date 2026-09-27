import type { Role, SiteId } from '../core/types';
import { fold, searchText, tokenize } from './normalize';
import { parseQuery, type Clause } from './query';

/**
 * Full-text search over saved conversations.
 *
 * Every conversation keeps a precomputed search text (folded tokens joined by spaces, built once
 * when it's saved). A query scans those strings with indexOf: " term" finds tokens that start with
 * the term, " exact phrase " finds a phrase. That handles prefixes, phrases and every script
 * without an inverted index, starts instantly (nothing to build when the page opens), and scans
 * ~15 MB of text (1,000 long conversations) in well under 100 ms (see test/perf.test.ts).
 *
 * Ranking: for each clause, log(1 + occurrences in the conversation) plus a title bonus; the sum
 * is multiplied by a recency factor (up to 1.5× for a conversation updated today, halving every
 * 30 days). Quoted phrases weigh more than single words.
 */

export interface SearchDoc {
  key: string;
  site: SiteId;
  title: string;
  url: string;
  updatedAt: number;
  messages: { role: Role; text: string }[];
  /** normalize.searchText of the messages. */
  searchText: string;
}

export interface SearchResult {
  doc: SearchDoc;
  score: number;
}

export interface SearchOptions {
  site?: SiteId | 'all';
  now?: number;
}

export interface SearchOutcome {
  results: SearchResult[];
  clauses: Clause[];
  /** Milliseconds spent searching. */
  took: number;
}

export const TITLE_BOOST = 2.5;
export const PHRASE_WEIGHT = 1.5;
export const RECENCY_BOOST = 0.5;
export const RECENCY_HALF_LIFE_DAYS = 30;
/**
 * Counting stops here. Scores grow with log(1 + count), so more hits barely change the ranking,
 * and stopping early keeps very common words cheap.
 */
const MAX_COUNT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry {
  doc: SearchDoc;
  titleText: string;
}

export class SearchIndex {
  private readonly entries: Entry[];

  constructor(docs: readonly SearchDoc[]) {
    this.entries = docs.map((doc) => ({ doc, titleText: ` ${tokenize(fold(doc.title)).join(' ')} ` }));
  }

  get size(): number {
    return this.entries.length;
  }

  search(query: string, options: SearchOptions = {}): SearchOutcome {
    const started = performance.now();
    const clauses = parseQuery(query);
    const site = options.site ?? 'all';
    const now = options.now ?? Date.now();
    const candidates = site === 'all' ? this.entries : this.entries.filter((entry) => entry.doc.site === site);

    let results: SearchResult[];
    if (clauses.length === 0) {
      // No query: browse everything, newest first.
      results = candidates.map((entry) => ({ doc: entry.doc, score: 0 })).sort(byRecency);
    } else {
      // Longer needles are usually rarer: checking them first rejects most conversations early.
      const ordered = [...clauses].sort((a, b) => b.needle.length - a.needle.length);
      results = [];
      for (const entry of candidates) {
        let score = 0;
        for (const clause of ordered) {
          const inTitle = countOccurrences(entry.titleText, clause.needle, 1);
          const inBody = countOccurrences(entry.doc.searchText, clause.needle, MAX_COUNT);
          if (inTitle === 0 && inBody === 0) {
            score = -1;
            break;
          }
          const weight = clause.kind === 'word' ? 1 : PHRASE_WEIGHT;
          score += weight * (Math.log1p(inBody) + TITLE_BOOST * inTitle);
        }
        if (score >= 0) results.push({ doc: entry.doc, score: score * recencyFactor(entry.doc.updatedAt, now) });
      }
      results.sort((a, b) => b.score - a.score || byRecency(a, b));
    }
    return { results, clauses, took: performance.now() - started };
  }
}

export function recencyFactor(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, now - updatedAt) / DAY_MS;
  return 1 + RECENCY_BOOST * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function countOccurrences(haystack: string, needle: string, max: number): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < max) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function byRecency(a: SearchResult, b: SearchResult): number {
  return b.doc.updatedAt - a.doc.updatedAt;
}

/** Index of the message that matches the most clauses (the best place for a snippet), or -1. */
export function bestMessage(doc: SearchDoc, clauses: readonly Clause[]): number {
  if (clauses.length === 0) return -1;
  const parts = doc.searchText.split('\n');
  let best = -1;
  let bestScore = 0;
  parts.forEach((part, index) => {
    const padded = part.endsWith(' ') ? part : `${part} `;
    let matched = 0;
    let hits = 0;
    for (const clause of clauses) {
      const count = countOccurrences(padded.startsWith(' ') ? padded : ` ${padded}`, clause.needle, MAX_COUNT);
      if (count) matched++;
      hits += count;
    }
    const score = matched * 1000 + hits;
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

/** Builds the search text for a conversation's messages (stored with each saved conversation). */
export function buildSearchText(messages: readonly { text: string }[]): string {
  return searchText(messages.map((message) => message.text));
}
