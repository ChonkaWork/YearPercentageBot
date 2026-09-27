import { fold, tokenize } from './normalize';

/**
 * One condition of a query. Every clause must match (AND).
 *   - word:     `regex`         → a token starting with "regex"
 *   - phrase:   `"sort key"`    → these exact tokens, in this order
 *   - sequence: `snake_case`    → tokens in order, the last one a prefix (a bare word that
 *               splits into several tokens, e.g. "e-mail", "5.25" or Chinese text)
 */
export interface Clause {
  kind: 'word' | 'phrase' | 'sequence';
  tokens: string[];
  /** What to look for in search text (see normalize.searchText). */
  needle: string;
}

const MAX_CLAUSES = 12;

export function parseQuery(query: string): Clause[] {
  const normalized = query.replace(/[“”„«»]/g, '"');
  const clauses: Clause[] = [];
  const seen = new Set<string>();
  for (const match of normalized.matchAll(/"([^"]*)"?|([^\s"]+)/g)) {
    const quoted = match[1] !== undefined;
    const tokens = tokenize(fold(match[1] ?? match[2] ?? ''));
    if (tokens.length === 0) continue;
    const kind = quoted ? 'phrase' : tokens.length > 1 ? 'sequence' : 'word';
    const needle = ` ${tokens.join(' ')}${kind === 'phrase' ? ' ' : ''}`;
    if (seen.has(needle)) continue;
    seen.add(needle);
    clauses.push({ kind, tokens, needle });
    if (clauses.length === MAX_CLAUSES) break;
  }
  return clauses;
}
