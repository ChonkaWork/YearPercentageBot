/**
 * Maximum size of the selected content (in characters, after cleanup) that Pastebot
 * turns into a prompt.
 *
 * 100k characters is roughly 25k tokens: enough for a long article, a full stack trace
 * or a large source file, while cleanup stays instant and the result is still sane to
 * paste into a chat UI. Bigger selections are rejected with a clear message and an
 * option to keep only the first MAX_INPUT_CHARS characters.
 */
export const MAX_INPUT_CHARS = 100_000;

/**
 * Hard cap on how much text is read from a page at all. Protects against "select all"
 * on huge pages flooding extension messaging. Anything above MAX_INPUT_CHARS is rejected
 * anyway, this only bounds the amount of work.
 */
export const MAX_CAPTURE_CHARS = 1_000_000;

export const MAX_CUSTOM_INSTRUCTION_CHARS = 2_000;

/**
 * Cuts `text` to at most `limit` characters, preferring a paragraph, line or word
 * boundary close to the limit so the cut doesn't land mid-word.
 */
export function truncateToLimit(text: string, limit: number = MAX_INPUT_CHARS): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  // Don't leave half of a surrogate pair (emoji etc.) at the end.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const minBoundary = Math.floor(limit * 0.9);
  for (const boundary of ['\n\n', '\n', ' ']) {
    const index = cut.lastIndexOf(boundary);
    if (index >= minBoundary) return cut.slice(0, index).trimEnd();
  }
  return cut;
}
