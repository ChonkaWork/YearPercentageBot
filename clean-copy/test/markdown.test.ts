import { describe, expect, it } from 'vitest';
import { applyEditsToText } from '../src/core/changes';
import { markdownStep } from '../src/core/markdown';

const md = (text: string) => markdownStep(text).text;

describe('remove Markdown syntax', () => {
  it('removes headings, emphasis and inline code', () => {
    expect(md('# Title\n## Section ##\nSome **bold**, *italic*, __strong__, _em_ and ~~old~~ text with `code`.')).toBe(
      'Title\nSection\nSome bold, italic, strong, em and old text with code.',
    );
    expect(md('***both***')).toBe('both');
  });

  it('turns links into "text (url)", images into their alt text, autolinks into addresses', () => {
    expect(md('See [the guide](https://example.com/guide "Guide") and ![Logo](https://example.com/logo.png).')).toBe(
      'See the guide (https://example.com/guide) and Logo.',
    );
    expect(md('[https://example.com](https://example.com) or <https://example.org/a_b_c>')).toBe('https://example.com or https://example.org/a_b_c');
    expect(md('[Kyiv](https://en.wikipedia.org/wiki/Kyiv_(city))')).toBe('Kyiv (https://en.wikipedia.org/wiki/Kyiv_(city))');
  });

  it('normalizes * and + bullets to "- " and removes rules; numbered lists and quotes stay', () => {
    expect(md('* one\n+ two\n  * nested **item**\n- three\n\n---\n1. first\n> quoted')).toBe('- one\n- two\n  - nested item\n- three\n\n\n1. first\n> quoted');
    expect(md('Title\n=====\ntext')).toBe('Title\n\ntext');
  });

  it('keeps code fences verbatim', () => {
    const text = 'Run:\n```js\nconst a = **b** * c; // [x](y)\n```\n**done**\n~~~\n# not a heading\n~~~';
    expect(md(text)).toBe('Run:\n```js\nconst a = **b** * c; // [x](y)\n```\ndone\n~~~\n# not a heading\n~~~');
  });

  it('leaves ordinary text alone: snake_case, math, addresses, escapes', () => {
    for (const text of ['file_name_here and some_var', '2 * 3 * 4 = 24', 'https://example.com/a_b_c?x=*y*', '#hashtag', 'Price: $5']) {
      expect(md(text)).toBe(text);
    }
    expect(md('A literal \\*star\\* and `a \\* b`')).toBe('A literal *star* and a \\* b');
  });

  it('reports every removal as an edit and counts constructs', () => {
    const input = '## Hi **there** [a](https://x.example)';
    const step = markdownStep(input);
    expect(applyEditsToText(input, step.edits)).toBe(step.text);
    expect(step.count).toBe(3);
    expect(step.edits.every((edit) => edit.kind === 'markdown')).toBe(true);
  });
});
