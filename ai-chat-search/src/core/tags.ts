import { fold } from '../search/normalize';

/** Tags on saved conversations (Pro). Pure. */

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_CONVERSATION = 20;

/**
 * Cleans a tag typed by the user: trims, drops a leading "#", collapses whitespace, cuts to
 * MAX_TAG_LENGTH characters. Returns '' when nothing is left.
 */
export function cleanTag(raw: string): string {
  const text = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '');
  return Array.from(text).slice(0, MAX_TAG_LENGTH).join('').trim();
}

/** Tags compare case- and accent-insensitively ("Rust" and "rust" are the same tag). */
export function tagKey(tag: string): string {
  return fold(cleanTag(tag));
}

/** Cleans, drops empties and duplicates (first spelling wins), caps the count. */
export function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = cleanTag(item);
    const key = tagKey(tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === MAX_TAGS_PER_CONVERSATION) break;
  }
  return out;
}

export function hasTag(tags: readonly string[], tag: string): boolean {
  const key = tagKey(tag);
  return tags.some((candidate) => tagKey(candidate) === key);
}

/** Adds a tag (no-op for duplicates or when full). Also accepts "a, b" to add several. */
export function addTags(tags: readonly string[], input: string): string[] {
  return sanitizeTags([...tags, ...input.split(',')]);
}

export function removeTag(tags: readonly string[], tag: string): string[] {
  const key = tagKey(tag);
  return tags.filter((candidate) => tagKey(candidate) !== key);
}

/** Every tag in use with its count, most used first, then alphabetically. */
export function tagCounts(lists: readonly (readonly string[])[]): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const tags of lists) {
    for (const tag of tags) {
      const key = tagKey(tag);
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
