/**
 * UI labels that end up in selections on news sites, GitHub, Stack Overflow, LinkedIn and
 * YouTube. Only ever matched against a whole line.
 */
const UI_NOISE_LINES = new Set([
  'skip to content',
  'skip to main content',
  'skip to navigation',
  'toggle navigation',
  'back to top',
  'scroll to top',
  'share',
  'copy link',
  'copy code',
  'copy to clipboard',
  'show more',
  'show less',
  'see more',
  'see less',
  'read more',
  'load more',
  'reply',
  'like',
  'repost',
  'subscribe',
  'follow',
  'report',
  'upvote',
  'downvote',
  'add a comment',
  'improve this question',
  'improve this answer',
  'advertisement',
  'sponsored',
  'promoted',
]);

export function isUiNoise(line: string): boolean {
  const normalized = line
    .trim()
    .toLowerCase()
    .replace(/^[‹«<\s]+|[\s.…›»>:]+$/g, '');
  return normalized.length <= 30 && UI_NOISE_LINES.has(normalized);
}
