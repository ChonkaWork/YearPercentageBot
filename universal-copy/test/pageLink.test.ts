import { describe, expect, it } from 'vitest';
import { cleanPageUrl, pageLinkMarkdown, pageLinkTitle } from '../src/core/pageLink';

describe('page link as Markdown', () => {
  it('copies [title](url) and an HTML link', () => {
    expect(pageLinkMarkdown('Universal Copy', 'https://example.com/tools/copy')).toEqual({
      text: '[Universal Copy](https://example.com/tools/copy)',
      html: '<a href="https://example.com/tools/copy">Universal Copy</a>',
    });
  });

  it('removes tracking parameters and keeps the rest of the address', () => {
    expect(cleanPageUrl('https://example.com/a?id=7&utm_source=x&fbclid=y#part')).toBe('https://example.com/a?id=7#part');
    expect(cleanPageUrl('https://example.com/a?utm_medium=email')).toBe('https://example.com/a');
    expect(pageLinkMarkdown('A', 'https://example.com/?gclid=1&q=a%20b')?.text).toBe('[A](https://example.com/?q=a+b)');
  });

  it('only links web pages', () => {
    for (const url of ['chrome://version', 'file:///home/me/a.html', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', '', undefined]) {
      expect(pageLinkMarkdown('Title', url)).toBeNull();
    }
  });

  it('escapes the title so it stays text, and the HTML', () => {
    const link = pageLinkMarkdown('[Draft] *Notes* <b> & `code`', 'https://example.com/');
    expect(link?.text).toBe('[\\[Draft\\] \\*Notes\\* \\<b> & \\`code\\`](https://example.com/)');
    expect(link?.html).toBe('<a href="https://example.com/">[Draft] *Notes* &lt;b&gt; &amp; `code`</a>');
    expect(pageLinkMarkdown('x', 'https://example.com/?a="b"')?.html).toBe('<a href="https://example.com/?a=%22b%22">x</a>');
  });

  it('keeps parentheses in addresses parseable', () => {
    expect(pageLinkMarkdown('Kyiv', 'https://en.wikipedia.org/wiki/Kyiv_(disambiguation)')?.text).toBe('[Kyiv](https://en.wikipedia.org/wiki/Kyiv_(disambiguation))');
    expect(pageLinkMarkdown('Odd', 'https://example.com/a)b')?.text).toBe('[Odd](https://example.com/a%29b)');
  });

  it('puts the title on one line, and uses the address when there is no title', () => {
    expect(pageLinkTitle('  Line one\n\tline\u{200b} two ', 'https://example.com/')).toBe('Line one line two');
    expect(pageLinkTitle('', 'https://www.example.com/docs/page')).toBe('example.com/docs/page');
    expect(pageLinkTitle(undefined, 'https://example.com/')).toBe('example.com');
  });
});
