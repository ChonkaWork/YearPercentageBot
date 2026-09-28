// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { escapeMarkdown, htmlToMarkdown, htmlToText, plainTextToMarkdown } from '../src/core/htmlToMarkdown';

function dom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

const md = (html: string, skip?: string) => htmlToMarkdown(dom(html), { baseUrl: 'https://chatgpt.com/c/abc', ...(skip ? { skip } : {}) });
const txt = (html: string) => htmlToText(dom(html), { baseUrl: 'https://chatgpt.com/c/abc' });

const KATEX_INLINE = (tex: string) =>
  `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">x</span></span></span>`;

describe('htmlToMarkdown: text and inline formatting', () => {
  it('converts paragraphs and collapses source whitespace', () => {
    expect(md('<p>Hello   \n  world</p>\n\n   <p>Second</p>')).toBe('Hello world\n\nSecond');
  });

  it('converts bold, italic, strikethrough and inline code', () => {
    expect(md('<p><strong>bold</strong>, <em>italic</em>, <del>gone</del> and <code>x = 1</code></p>')).toBe(
      '**bold**, *italic*, ~~gone~~ and `x = 1`',
    );
  });

  it('keeps spaces outside emphasis markers', () => {
    expect(md('<p>a<strong> bold </strong>b</p>')).toBe('a **bold** b');
    expect(md('<p><em> </em>x</p>')).toBe('x');
  });

  it('uses a longer fence for inline code containing backticks', () => {
    expect(md('<p><code>a`b</code></p>')).toBe('``a`b``');
    expect(md('<p><code>`tick`</code></p>')).toBe('`` `tick` ``');
  });

  it('keeps multiple spaces inside inline code', () => {
    expect(md('<p><code>a  b</code></p>')).toBe('`a  b`');
  });

  it('escapes Markdown syntax in text', () => {
    expect(md('<p>2 * 3 = 6, [not a link], `tick`, $5 and <b>&lt;div&gt;</b></p>')).toBe(
      '2 \\* 3 = 6, \\[not a link\\], \\`tick\\`, \\$5 and **\\<div>**',
    );
  });

  it('leaves snake_case and comparisons readable', () => {
    expect(md('<p>use snake_case when x &lt; y</p>')).toBe('use snake_case when x < y');
    expect(md('<p>def __init__(self)</p>')).toBe('def \\_\\_init\\_\\_(self)');
  });

  it('escapes block syntax at the start of a line', () => {
    expect(md('<p># not a heading</p>')).toBe('\\# not a heading');
    expect(md('<p>1. not a list</p>')).toBe('1\\. not a list');
    expect(md('<p>- not a list</p>')).toBe('\\- not a list');
    expect(md('<p>&gt; not a quote</p>')).toBe('\\> not a quote');
    expect(md('<p>---</p>')).toBe('\\---');
  });

  it('turns <br> into hard breaks', () => {
    expect(md('<p>line one<br>line two<br></p>')).toBe('line one  \nline two');
    expect(txt('<p>line one<br>line two</p>')).toBe('line one\nline two');
  });

  it('escapes backslashes only where Markdown would eat them', () => {
    expect(md('<p>C:\\Users\\me and \\*</p>')).toBe('C:\\Users\\me and \\\\\\*');
    expect(escapeMarkdown('a\\b')).toBe('a\\b');
  });
});

describe('htmlToMarkdown: pre-wrap text (user messages)', () => {
  it('keeps newlines and blank lines of pre-wrap text', () => {
    const html = '<div class="whitespace-pre-wrap">First line\nSecond line\n\nNew paragraph</div>';
    expect(md(html)).toBe('First line  \nSecond line\n\nNew paragraph');
    expect(txt(html)).toBe('First line\nSecond line\n\nNew paragraph');
  });

  it('keeps indentation of pasted code in plain text', () => {
    const html = '<div class="whitespace-pre-wrap">def f():\n    return 1</div>';
    expect(txt(html)).toBe('def f():\n    return 1');
    expect(md(html)).toBe('def f():  \n    return 1');
  });

  it('honours inline white-space styles and Tailwind important modifiers', () => {
    expect(txt('<div style="white-space: pre-wrap">a\nb</div>')).toBe('a\nb');
    expect(txt('<div class="!whitespace-pre-wrap">a\nb</div>')).toBe('a\nb');
    expect(txt('<div class="whitespace-pre-wrap"><span class="whitespace-normal">a\nb</span></div>')).toBe('a b');
  });
});

describe('plainTextToMarkdown (typed text from an export)', () => {
  it('renders like the same text in a pre-wrap element on the page', () => {
    for (const text of ['First line\nSecond line\n\nNew paragraph', 'def f():\n    return 1', 'I tried `sorted(data)` and got a *TypeError*.', '# not a heading\n- not a list\n1. not a list\n> not a quote']) {
      const element = document.createElement('div');
      element.className = 'whitespace-pre-wrap';
      element.textContent = text;
      expect(plainTextToMarkdown(text)).toBe(htmlToMarkdown(element));
    }
  });

  it('normalizes line endings and drops trailing space and outer blank lines', () => {
    expect(plainTextToMarkdown('\r\n\nHello  \r\nworld\n\n\n\nBye\n\n')).toBe('Hello  \nworld\n\nBye');
  });
});

describe('htmlToMarkdown: headings, quotes, rules', () => {
  it('converts headings', () => {
    expect(md('<h1>Title</h1><h3>Sub <em>title</em></h3>')).toBe('# Title\n\n### Sub *title*');
    expect(txt('<h2>Plain</h2><p>x</p>')).toBe('Plain\n\nx');
  });

  it('converts blockquotes, including nested ones', () => {
    expect(md('<blockquote><p>Quoted</p><p>Two</p><blockquote><p>Inner</p></blockquote></blockquote>')).toBe(
      '> Quoted\n>\n> Two\n>\n> > Inner',
    );
  });

  it('converts horizontal rules', () => {
    expect(md('<p>a</p><hr><p>b</p>')).toBe('a\n\n---\n\nb');
  });
});

describe('htmlToMarkdown: lists', () => {
  it('converts unordered and ordered lists', () => {
    expect(md('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
    expect(md('<ol start="3"><li>three</li><li>four</li></ol>')).toBe('3. three\n4. four');
  });

  it('nests lists with correct indentation', () => {
    const html = '<ol><li><p>Parent</p><ul><li>Child <strong>bold</strong><ul><li>Grandchild</li></ul></li></ul></li><li>Next</li></ol>';
    expect(md(html)).toBe('1. Parent\n   - Child **bold**\n     - Grandchild\n2. Next');
    expect(txt(html)).toBe('1. Parent\n   - Child bold\n     - Grandchild\n2. Next');
  });

  it('handles a nested list placed directly inside the parent list', () => {
    expect(md('<ul><li>a</li><ul><li>b</li></ul></ul>')).toBe('- a\n  - b');
  });

  it('makes a loose list when items hold several paragraphs', () => {
    expect(md('<ul><li><p>a</p><p>more</p></li><li><p>b</p></li></ul>')).toBe('- a\n\n  more\n\n- b');
  });

  it('keeps code blocks inside list items indented', () => {
    const html = '<ol><li><p>Run:</p><pre><code class="language-bash">npm test\nnpm run build</code></pre></li></ol>';
    expect(md(html)).toBe('1. Run:\n\n   ```bash\n   npm test\n   npm run build\n   ```');
  });

  it('renders task list checkboxes', () => {
    expect(md('<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox"> todo</li></ul>')).toBe(
      '- [x] done\n- [ ] todo',
    );
  });
});

describe('htmlToMarkdown: code blocks', () => {
  it('takes the language from the code class', () => {
    expect(md('<pre><code class="hljs language-python">print("hi")\n</code></pre>')).toBe('```python\nprint("hi")\n```');
  });

  it('keeps code verbatim: blank lines, indentation, Markdown characters', () => {
    const code = 'def f(x):\n    # comment *not* emphasis\n\n\n    return x_1 * 2';
    expect(md(`<pre><code class="language-python">${code}</code></pre>`)).toBe(`\`\`\`python\n${code}\n\`\`\``);
    expect(txt(`<pre><code class="language-python">${code}</code></pre>`)).toBe(code);
  });

  it('reads the language from a ChatGPT-style header and drops "Copy code"', () => {
    const html =
      '<pre class="overflow-visible!"><div class="contain-inline-size rounded-md"><div class="flex items-center px-4 py-2 text-xs">javascript<div class="sticky"><button aria-label="Copy"><svg></svg>Copy code</button></div></div>' +
      '<div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! hljs"><span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;</code></div></div></pre>';
    expect(md(html)).toBe('```javascript\nconst a = 1;\n```');
  });

  it('reads the language from a label above the code (Claude style)', () => {
    const html =
      '<div class="relative"><div class="sticky"><button>Copy</button></div><div class="text-text-500 font-small">rust</div>' +
      '<div class="overflow-x-auto"><pre class="code-block__code"><code style="white-space: pre;">fn main() {}</code></pre></div></div>';
    expect(md(html)).toBe('```rust\nfn main() {}\n```');
  });

  it('does not take a preceding paragraph as the language', () => {
    expect(md('<p>Output</p><pre><code>42</code></pre>')).toBe('Output\n\n```\n42\n```');
  });

  it('uses a longer fence when the code contains backtick fences', () => {
    expect(md('<pre><code class="language-markdown">```js\nx\n```</code></pre>')).toBe('````markdown\n```js\nx\n```\n````');
  });

  it('reads CodeMirror-style lines when there is no <code>', () => {
    expect(md('<pre><div class="cm-content"><div class="cm-line">a = 1</div><div class="cm-line">b = 2</div></div></pre>')).toBe(
      '```\na = 1\nb = 2\n```',
    );
  });
});

describe('htmlToMarkdown: tables', () => {
  const table =
    '<div class="tableContainer"><button>Copy table</button><table><thead><tr><th>Name</th><th align="right">Price</th></tr></thead>' +
    '<tbody><tr><td>Tea | green</td><td>$3</td></tr><tr><td><strong>Coffee</strong></td><td>4</td></tr><tr><td>Water</td></tr></tbody></table></div>';

  it('converts tables to GFM with alignment, escaping pipes and padding short rows', () => {
    expect(md(table)).toBe(
      '| Name | Price |\n| --- | ---: |\n| Tea \\| green | \\$3 |\n| **Coffee** | 4 |\n| Water |  |',
    );
  });

  it('renders tables as rows in plain text', () => {
    expect(txt(table)).toBe('Name | Price\nTea | green | $3\nCoffee | 4\nWater |');
  });

  it('uses the first row as header when there is no <thead>', () => {
    expect(md('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>')).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('flattens line breaks inside cells', () => {
    expect(md('<table><tr><th>h</th></tr><tr><td>one<br>two</td></tr></table>')).toBe('| h |\n| --- |\n| one two |');
  });
});

describe('htmlToMarkdown: links and images', () => {
  it('converts links and resolves relative URLs', () => {
    expect(md('<p>See <a href="https://example.com/docs">the docs</a> and <a href="/c/other">this</a>.</p>')).toBe(
      'See [the docs](https://example.com/docs) and [this](https://chatgpt.com/c/other).',
    );
  });

  it('writes bare URLs as autolinks', () => {
    expect(md('<p><a href="https://example.com/">https://example.com/</a></p>')).toBe('<https://example.com/>');
  });

  it('drops unsafe link targets but keeps the text', () => {
    expect(md('<p><a href="javascript:alert(1)">click</a></p>')).toBe('click');
  });

  it('encodes spaces and parentheses in link destinations', () => {
    expect(md('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">wiki</a></p>')).toBe('[wiki](https://en.wikipedia.org/wiki/Foo_%28bar%29)');
  });

  it('renders images as links', () => {
    expect(md('<p><img src="https://files.example.com/cat.png" alt="A cat"></p>')).toBe('[Image: A cat](https://files.example.com/cat.png)');
    expect(txt('<p><img src="https://files.example.com/cat.png" alt="A cat"></p>')).toBe('[Image: A cat] (https://files.example.com/cat.png)');
  });

  it('does not link blob: or data: images', () => {
    expect(md('<p><img src="blob:https://chatgpt.com/123" alt="upload"></p>')).toBe('\\[Image: upload\\]');
  });

  it('does not nest images inside links', () => {
    expect(md('<p><a href="https://example.com"><img src="https://example.com/favicon.ico" alt="">Example</a></p>')).toBe(
      '[Example](https://example.com/)',
    );
  });

  it('writes link URLs after the text in plain text', () => {
    expect(txt('<p><a href="https://example.com/a">docs</a></p>')).toBe('docs (https://example.com/a)');
  });
});

describe('htmlToMarkdown: math', () => {
  it('keeps TeX source of inline KaTeX', () => {
    expect(md(`<p>Energy ${KATEX_INLINE('E = mc^2')} holds.</p>`)).toBe('Energy $E = mc^2$ holds.');
  });

  it('keeps TeX source of display KaTeX as a $$ block', () => {
    const html = `<p>Sum:</p><span class="katex-display">${KATEX_INLINE('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}')}</span><p>done</p>`;
    expect(md(html)).toBe('Sum:\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\ndone');
  });

  it('keeps TeX in plain text too', () => {
    expect(txt(`<p>${KATEX_INLINE('a^2')}</p>`)).toBe('$a^2$');
  });

  it('never outputs the aria-hidden visual copy', () => {
    expect(md(`<p>${KATEX_INLINE('x')}</p>`)).not.toContain('base');
  });
});

describe('htmlToMarkdown: UI chrome', () => {
  it('drops buttons, icons, hidden and screen-reader-only elements', () => {
    const html =
      '<p>Answer<button>Copy</button><svg><path d="M0"/></svg></p><span class="sr-only">ChatGPT said:</span><div hidden>secret</div><div style="display:none">none</div><div role="toolbar"><span>Edit</span></div>';
    expect(md(html)).toBe('Answer');
  });

  it('drops site-specific chrome passed by the adapter', () => {
    expect(md('<p>Keep</p><div data-testid="action-bar-copy">Copy</div>', '[data-testid="action-bar-copy"]')).toBe('Keep');
  });

  it('never runs or keeps markup from the message', () => {
    const out = md('<p>&lt;script&gt;alert(1)&lt;/script&gt; <img src=x onerror="alert(1)"></p>');
    expect(out).toBe('\\<script>alert(1)\\</script> [Image](https://chatgpt.com/c/x)');
  });

  it('treats inline wrappers around blocks as blocks', () => {
    expect(md('<span><p>one</p><p>two</p></span>')).toBe('one\n\ntwo');
  });

  it('returns an empty string for empty content', () => {
    expect(md('<div>  <span> </span> </div>')).toBe('');
  });

  it('accepts several roots', () => {
    const a = dom('<p>first</p>');
    const b = dom('<p>second</p>');
    expect(htmlToMarkdown([a, b])).toBe('first\n\nsecond');
  });
});
