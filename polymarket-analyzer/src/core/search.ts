export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_LENGTH = 100;

/**
 * Cleans a search query (typed, or taken from a text selection): collapses whitespace, strips
 * surrounding quotes and punctuation, and caps the length. Returns '' when too short.
 */
export function normalizeQuery(value: string): string {
  const cleaned = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’«»(\[]+|["'“”‘’«»)\]?!.,:;]+$/g, '')
    .trim()
    .slice(0, MAX_SEARCH_LENGTH)
    .trim();
  return cleaned.length >= MIN_SEARCH_LENGTH ? cleaned : '';
}
