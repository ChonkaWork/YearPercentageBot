/**
 * Counts shown under the popup preview: words (Unicode-aware, so Chinese, Japanese and Thai
 * count words, not characters or spaces) and an approximate token count for AI tools. Pure.
 */

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

/** Above this, counting by whitespace is close enough and much faster. */
const SEGMENT_LIMIT = 200_000;

export function countWords(text: string): number {
  if (!text.trim()) return 0;
  if (!segmenter || text.length > SEGMENT_LIMIT) return text.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  let count = 0;
  for (const segment of segmenter.segment(text)) if (segment.isWordLike) count++;
  return count;
}

/** The usual rule of thumb for English text with GPT-style tokenizers: about 4 characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Words of an HTML source, ignoring the tags (for counting only; nothing is parsed or rendered). */
export function htmlWords(html: string): number {
  return countWords(html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' '));
}
