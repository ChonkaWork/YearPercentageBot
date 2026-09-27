// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { convertSelection } from '../src/core/convert';
import { toCleanHtml } from '../src/core/html';
import { defaultSettings } from '../src/core/settings';
import { el } from '../src/core/snapshot';
import { snapshotOf } from './helpers';

const clean = (html: string, head = '') => toCleanHtml(snapshotOf(html, head));

describe('toCleanHtml', () => {
  it('keeps structure and drops styling', () => {
    const html =
      '<div class="post" style="color:red"><h2 id="t" class="title" style="font:40px Comic Sans">Title</h2><p style="margin:0">Some <b>bold</b> and <i>italic</i> <span style="color:blue">text</span>.</p><ul><li>One</li><li>Two</li></ul></div>';
    expect(clean(html)).toBe('<h2>Title</h2>\n<p>Some <strong>bold</strong> and <em>italic</em> text.</p>\n<ul><li>One</li>\n<li>Two</li>\n</ul>');
  });

  it('removes scripts, event handlers, iframes, forms, SVG and unsafe URLs', () => {
    const html =
      '<p onclick="steal()">Hello<script>alert(1)</script><img src="x.png" onerror="alert(2)" alt="pic"><iframe src="https://evil.example"></iframe><svg><script>alert(3)</script></svg><a href="javascript:alert(4)">bad</a> <a href="https://ok.example/" onmouseover="x()" target="_blank" style="color:red">good</a><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="svg"></p><form><input name="password"></form><style>p{}</style>';
    const output = clean(html);
    expect(output).toBe('<p>Hello<img src="https://example.com/docs/x.png" alt="pic">bad <a href="https://ok.example/">good</a>svg</p>');
    expect(output).not.toMatch(/script|onerror|onclick|onmouseover|iframe|style|javascript|svg\+xml|target/i);
  });

  it('escapes page text so it can never become markup', () => {
    expect(clean('<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;</p>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; &amp; "quotes"</p>');
  });

  it('keeps table spans and code languages, nothing else', () => {
    expect(clean('<table class="wikitable" border="1"><tr><td colspan="2" style="x" width="50">a</td></tr><tr><td>b</td><td></td></tr></table>')).toBe(
      '<table><tbody><tr><td colspan="2">a</td></tr>\n<tr><td>b</td><td></td></tr>\n</tbody>\n</table>',
    );
    expect(clean('<pre class="language-py" data-x="1"><code>print("&lt;hi&gt;")</code></pre>')).toBe(
      '<pre><code class="language-py">print("&lt;hi&gt;")</code></pre>',
    );
  });

  it('escapes attribute values', () => {
    expect(toCleanHtml([el('img', { src: 'https://e.com/a.png?x="><script>', alt: '"><script>alert(1)</script>' })])).toBe(
      '<img src="https://e.com/a.png?x=%22%3E%3Cscript%3E" alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">',
    );
  });

  it('comes with a clean text version for text/plain', () => {
    const snapshot = { kind: 'dom' as const, nodes: snapshotOf('<h1>Hi</h1><p>there</p>'), truncated: false, url: 'https://example.com/' };
    expect(convertSelection(snapshot, 'html', defaultSettings())).toEqual({ text: 'Hi\n\nthere', html: '<h1>Hi</h1>\n<p>there</p>' });
  });
});
