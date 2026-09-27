// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../src/core/htmlToMarkdown';
import { renderInline, renderMarkdown, safeHref } from '../src/render/markdown';

describe('renderMarkdown: blocks', () => {
  it('renders headings, paragraphs and rules', () => {
    expect(renderMarkdown('# Title\n\nSome text\nwrapped.\n\n---')).toBe('<h1>Title</h1>\n<p>Some text\nwrapped.</p>\n<hr>');
  });

  it('renders fenced code with a language label and escapes it', () => {
    expect(renderMarkdown('```python\nif a < b:\n    print("<b>")\n```')).toBe(
      '<div class="code-block"><div class="code-language">python</div><pre><code class="language-python">if a &#60; b:\n    print(&#34;&#60;b&#62;&#34;)</code></pre></div>',
    );
  });

  it('keeps an unclosed fence as code until the end', () => {
    expect(renderMarkdown('```\nx')).toBe('<div class="code-block"><pre><code>x</code></pre></div>');
  });

  it('renders nested lists, tight and loose', () => {
    expect(renderMarkdown('1. One\n   - Sub **b**\n2. Two')).toBe('<ol><li>One\n<ul><li>Sub <strong>b</strong></li></ul></li><li>Two</li></ol>');
    expect(renderMarkdown('- a\n\n  more\n\n- b')).toBe('<ul><li><p>a</p>\n<p>more</p></li><li><p>b</p></li></ul>');
    expect(renderMarkdown('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  it('renders task lists', () => {
    expect(renderMarkdown('- [x] done\n- [ ] todo')).toBe(
      '<ul><li class="task"><input type="checkbox" disabled checked> done</li><li class="task"><input type="checkbox" disabled> todo</li></ul>',
    );
  });

  it('renders blockquotes', () => {
    expect(renderMarkdown('> Quote\n>\n> > Inner')).toBe('<blockquote><p>Quote</p>\n<blockquote><p>Inner</p></blockquote></blockquote>');
  });

  it('renders tables with alignment and escaped pipes', () => {
    expect(renderMarkdown('| a | b |\n| --- | ---: |\n| x \\| y | 2 |')).toBe(
      '<table><thead><tr><th>a</th><th style="text-align: right">b</th></tr></thead><tbody><tr><td>x | y</td><td style="text-align: right">2</td></tr></tbody></table>',
    );
  });

  it('renders display math as TeX source', () => {
    expect(renderMarkdown('$$\n\\frac{a}{b} < 1\n$$')).toBe('<div class="math-display">\\frac{a}{b} &#60; 1</div>');
  });
});

describe('renderMarkdown: inline', () => {
  it('renders emphasis, code, strikethrough and breaks', () => {
    expect(renderInline('**bold** *it* ~~del~~ `a<b` x  \ny')).toBe('<strong>bold</strong> <em>it</em> <del>del</del> <code>a&#60;b</code> x<br>\ny');
  });

  it('keeps escaped characters literal', () => {
    expect(renderInline('\\*not\\* \\[x\\] \\$5 snake_case')).toBe('*not* [x] $5 snake_case');
  });

  it('renders inline math', () => {
    expect(renderInline('Energy $E = mc^2$ and $5 or $ 6')).toBe('Energy <span class="math-inline">E = mc^2</span> and $5 or $ 6');
  });

  it('renders safe links and autolinks', () => {
    expect(renderInline('[docs](https://example.com/a?b=1&c=2) <https://example.com>')).toBe(
      '<a href="https://example.com/a?b=1&#38;c=2" rel="noopener noreferrer">docs</a> <a href="https://example.com/" rel="noopener noreferrer">https://example.com</a>',
    );
  });

  it('renders images as links, never as <img>', () => {
    const html = renderInline('![a cat](https://example.com/cat.png)');
    expect(html).toBe('<a class="image-link" href="https://example.com/cat.png" rel="noopener noreferrer">Image: a cat</a>');
  });

  it('decodes entities and escapes the result', () => {
    expect(renderInline('&amp;copy; &lt;b&gt; &#65;')).toBe('&#38;copy; &#60;b&#62; A');
  });
});

describe('renderMarkdown: safety', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '![x](javascript:alert(1))',
    '<javascript:alert(1)>',
    '[x](https://example.com" onmouseover="alert(1))',
    '```"><script>alert(1)</script>\ncode\n```',
    '| <b>h</b> |\n| --- |\n| <i>c</i> |',
    '$<img src=x>$',
    '&lt;script&gt;',
  ];

  for (const attack of attacks) {
    it(`does not produce markup from: ${attack.slice(0, 40)}`, () => {
      const html = renderMarkdown(attack);
      const container = document.createElement('div');
      container.innerHTML = html;
      expect(container.querySelector('script, img, iframe, [onerror], [onmouseover], [onclick]')).toBeNull();
      for (const link of Array.from(container.querySelectorAll('a'))) {
        expect(link.getAttribute('href') ?? '').toMatch(/^(https?:|mailto:)/);
      }
    });
  }

  it('allows only http(s) and mailto links', () => {
    expect(safeHref('https://a.b/')).toBe('https://a.b/');
    expect(safeHref('mailto:x@y.z')).toBe('mailto:x@y.z');
    expect(safeHref(' javascript:alert(1)')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
  });
});

describe('round trip: converter output renders back to equivalent structure', () => {
  it('keeps structure through HTML → Markdown → HTML', () => {
    const source = document.createElement('div');
    source.innerHTML =
      '<h2>Plan</h2><p>Use <strong>bold</strong>, <em>it</em>, <code>x_y</code> and <a href="https://example.com/">a link</a>.</p>' +
      '<ol><li>First<ul><li>Nested <em>item</em></li></ul></li><li>Second</li></ol>' +
      '<pre><code class="language-js">const a = "&lt;b&gt;";</code></pre>' +
      '<table><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>a|b</td><td>$5</td></tr></tbody></table>' +
      '<blockquote><p>Quote with 2 * 3</p></blockquote><p>snake_case, __dunder__, 1. not list</p>';
    const rendered = document.createElement('div');
    rendered.innerHTML = renderMarkdown(htmlToMarkdown(source));
    expect(rendered.querySelector('h2')?.textContent).toBe('Plan');
    expect(rendered.querySelector('strong')?.textContent).toBe('bold');
    expect(rendered.querySelector('p code')?.textContent).toBe('x_y');
    expect(rendered.querySelector('a')?.getAttribute('href')).toBe('https://example.com/');
    expect(rendered.querySelector('ol > li > ul > li em')?.textContent).toBe('item');
    expect(rendered.querySelector('pre code.language-js')?.textContent).toBe('const a = "<b>";');
    expect(Array.from(rendered.querySelectorAll('td'), (cell) => cell.textContent)).toEqual(['a|b', '$5']);
    expect(rendered.querySelector('blockquote p')?.textContent).toBe('Quote with 2 * 3');
    expect(rendered.querySelector('blockquote + p')?.textContent).toBe('snake_case, __dunder__, 1. not list');
  });
});
