// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { escapeText, toMarkdown } from '../src/core/markdown';
import { el, text } from '../src/core/snapshot';
import { snapshotOf } from './helpers';

const md = (html: string, head = '') => toMarkdown(snapshotOf(html, head));

describe('toMarkdown', () => {
  it('converts headings, paragraphs, emphasis and inline code', () => {
    expect(md('<h1>Title</h1><p>Some <strong>bold</strong>, <em>italic</em> and <code>code()</code> text.</p><h3>Sub <b>part</b></h3>')).toBe(
      '# Title\n\nSome **bold**, *italic* and `code()` text.\n\n### Sub **part**',
    );
  });

  it('moves spaces out of emphasis and ignores empty formatting', () => {
    expect(md('<p>A<b> bold </b>word<i> </i>end</p>')).toBe('A **bold** word end');
  });

  it('keeps fenced code blocks verbatim with the language from the class', () => {
    const html = '<pre><code class="language-js">const a = 1;\n\nif (a &lt; 2) {\n  console.log(`x`);\n}\n</code></pre>';
    expect(md(html)).toBe('```js\nconst a = 1;\n\nif (a < 2) {\n  console.log(`x`);\n}\n```');
  });

  it('reads GitHub-style highlight wrappers and uses a longer fence when the code has one', () => {
    const html = '<div class="highlight highlight-source-shell"><pre>echo "```"\nnpm test</pre></div>';
    expect(md(html)).toBe('````shell\necho "```"\nnpm test\n````');
  });

  it('writes inline code with backticks inside', () => {
    expect(md('<p>Run <code>a`b</code> now</p>')).toBe('Run ``a`b`` now');
  });

  it('makes links and images absolute and drops tracking parameters', () => {
    expect(md('<p><a href="../guide/?utm_source=x&amp;id=4">Guide</a> <img src="img/cat.png" alt="A cat"></p>')).toBe(
      '[Guide](https://example.com/guide/?id=4) ![A cat](https://example.com/docs/img/cat.png)',
    );
  });

  it('uses autolinks when the text is the URL, and drops unsafe links', () => {
    expect(md('<p><a href="https://example.com/x">https://example.com/x</a> <a href="javascript:alert(1)">Click</a></p>')).toBe(
      '<https://example.com/x> Click',
    );
  });

  it('prefers the real image over a lazy-loading placeholder', () => {
    expect(md('<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/real.jpg" alt="Photo"></p>')).toBe(
      '![Photo](https://example.com/real.jpg)',
    );
  });

  it('converts nested and ordered lists with correct indentation', () => {
    const html = '<ul><li>One<ul><li>One.a</li><li>One.b</li></ul></li><li>Two</li></ul><ol start="9"><li>Nine</li><li>Ten<ol><li>Sub</li></ol></li></ol>';
    expect(md(html)).toBe('- One\n  - One.a\n  - One.b\n- Two\n\n9. Nine\n10. Ten\n    1. Sub');
  });

  it('supports the bullet and emphasis settings', () => {
    expect(toMarkdown(snapshotOf('<ul><li><i>a</i></li></ul>'), { bullet: '*', emphasis: '_' })).toBe('* _a_');
  });

  it('writes task lists', () => {
    expect(md('<ul><li><input type="checkbox" checked disabled> Done</li><li><input type="checkbox" disabled> Todo</li></ul>')).toBe(
      '- [x] Done\n- [ ] Todo',
    );
  });

  it('converts blockquotes, line breaks and horizontal rules', () => {
    expect(md('<blockquote><p>Quote line 1<br>line 2</p><p>Second</p></blockquote><hr><p>After</p>')).toBe(
      '> Quote line 1  \n> line 2\n>\n> Second\n\n---\n\nAfter',
    );
  });

  it('converts tables with escaped pipes and line breaks', () => {
    const html = '<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td>one<br>two</td></tr></tbody></table>';
    expect(md(html)).toBe('| Key  | Value      |\n| ---- | ---------- |\n| a\\|b | one<br>two |');
  });

  it('ignores scripts, styles, hidden and screen-reader-only content', () => {
    const head = '<style>.hidden{display:none}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}</style>';
    const html =
      '<p>Visible<script>alert(1)</script><style>p{}</style><span class="hidden">HIDDEN</span><span aria-hidden="true">ARIA</span><span class="sr-only">SR</span><span hidden>ATTR</span> text</p><button>Share</button>';
    expect(md(html, head)).toBe('Visible text');
  });

  it('escapes text that would otherwise become Markdown', () => {
    expect(md('<p>*not bold* and [not a link](x) and 2 * 3 and snake_case and _init_</p><p># not a heading</p><p>1. not a list</p><p>- nor this</p>')).toBe(
      '\\*not bold\\* and \\[not a link\\](x) and 2 * 3 and snake_case and \\_init\\_\n\n\\# not a heading\n\n1\\. not a list\n\n\\- nor this',
    );
  });

  it('does not treat a card link wrapping blocks as a broken inline link', () => {
    expect(md('<a href="/post"><h3>Post title</h3><p>Summary</p></a>')).toBe('### Post title\n\nSummary');
  });

  it('keeps line breaks of white-space: pre-wrap content (chat messages)', () => {
    expect(md('<div style="white-space: pre-wrap">Line one\nLine two</div>')).toBe('Line one  \nLine two');
  });
});

describe('escapeText', () => {
  it('leaves harmless punctuation alone', () => {
    expect(escapeText('a < b, c > d, e & f, a_b, x ~ y')).toBe('a < b, c > d, e & f, a_b, x ~ y');
  });

  it('escapes HTML-looking text, entities, backslashes before punctuation and strikethrough', () => {
    expect(escapeText('<div> &amp; \\* ~~gone~~')).toBe('\\<div> \\&amp; \\\\\\* \\~\\~gone\\~\\~');
  });

  it('works on hand-built trees too', () => {
    expect(toMarkdown([el('p', null, text('x '), el('a', { href: 'https://e.com/a b(c' }, 'y'))])).toBe('x [y](https://e.com/a%20b%28c)');
  });
});
