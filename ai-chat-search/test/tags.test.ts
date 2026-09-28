import { describe, expect, it } from 'vitest';
import { addTags, cleanTag, hasTag, MAX_TAG_LENGTH, MAX_TAGS_PER_CONVERSATION, removeTag, sanitizeTags, tagCounts, tagKey } from '../src/core/tags';

describe('tags', () => {
  it('cleans what the user typed', () => {
    expect(cleanTag('  #rust  ')).toBe('rust');
    expect(cleanTag('##work   in\tprogress')).toBe('work in progress');
    expect(cleanTag('a\u0000b')).toBe('a b');
    expect(cleanTag('   ')).toBe('');
    expect(cleanTag('#')).toBe('');
    expect(Array.from(cleanTag('ж'.repeat(100)))).toHaveLength(MAX_TAG_LENGTH);
  });

  it('compares case- and accent-insensitively', () => {
    expect(tagKey('Café')).toBe(tagKey('cafe'));
    expect(tagKey('#Київ')).toBe(tagKey('київ'));
    expect(hasTag(['Rust', 'Python'], 'rust')).toBe(true);
    expect(hasTag(['Rust'], 'rus')).toBe(false);
  });

  it('sanitizes stored lists: strings only, no empties or duplicates, capped', () => {
    expect(sanitizeTags(undefined)).toEqual([]);
    expect(sanitizeTags('rust')).toEqual([]);
    expect(sanitizeTags(['Rust', 'rust', ' ', 3, null, 'Python'])).toEqual(['Rust', 'Python']);
    expect(sanitizeTags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS_PER_CONVERSATION);
  });

  it('adds one or several tags, keeping the first spelling', () => {
    expect(addTags(['Rust'], 'python')).toEqual(['Rust', 'python']);
    expect(addTags(['Rust'], 'RUST')).toEqual(['Rust']);
    expect(addTags([], 'work, ideas ,, #later')).toEqual(['work', 'ideas', 'later']);
  });

  it('removes a tag whatever its case', () => {
    expect(removeTag(['Rust', 'Python'], 'rust')).toEqual(['Python']);
    expect(removeTag(['Rust'], 'go')).toEqual(['Rust']);
  });

  it('counts tags across conversations, most used first', () => {
    expect(tagCounts([['work', 'Rust'], ['rust'], ['ideas', 'work'], ['rust']])).toEqual([
      { tag: 'Rust', count: 3 },
      { tag: 'work', count: 2 },
      { tag: 'ideas', count: 1 },
    ]);
  });
});
