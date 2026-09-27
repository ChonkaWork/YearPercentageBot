// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractText } from '../src/core/extract';
import { capSnapshot, normalizeText } from '../src/core/normalize';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('normalizeText', () => {
  it('trims lines, collapses spaces and drops blank lines and invisible characters', () => {
    expect(normalizeText('  a \t b \n\n\n c  d​ \r\n')).toBe('a b\nc d');
  });

  it('caps at a line boundary', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const { text: capped, truncated } = capSnapshot(text, 50);
    expect(truncated).toBe(true);
    expect(capped.endsWith('\n')).toBe(false);
    expect(capped.length).toBeLessThanOrEqual(50);
    expect(capSnapshot('short', 50)).toEqual({ text: 'short', truncated: false });
  });
});

describe('extractText', () => {
  it('puts blocks on their own lines and collapses source whitespace', () => {
    const doc = parse(`<body><h1>Widget
        Pro</h1><p>Only <b>$129</b>
      today</p><ul><li>One</li><li>Two</li></ul>Tail<br>after break</body>`);
    expect(extractText(doc.body)).toBe('Widget Pro\nOnly $129 today\nOne\nTwo\nTail\nafter break');
  });

  it('skips scripts, styles, templates, noscript and markup-hidden elements', () => {
    const doc = parse(`<body>
      <script>var x = "secret"</script><style>.a{}</style><template><p>tpl</p></template>
      <noscript>Enable JavaScript</noscript>
      <p hidden>hidden attr</p><p aria-hidden="true">aria hidden</p>
      <p style="color:red; display: none !important">inline none</p><p style="visibility:hidden">invisible</p>
      <dialog>closed dialog</dialog><dialog open>open dialog</dialog>
      <div hidden="until-found">found later</div>
      <svg><text>chart</text></svg><textarea>draft</textarea>
      <p>Visible</p></body>`);
    expect(extractText(doc.body)).toBe('open dialog\nfound later\nVisible');
  });

  it('turns table rows into one line with cell separators', () => {
    const doc = parse(`<table><thead><tr><th>Plan</th><th>Price</th><th></th></tr></thead>
      <tbody><tr><td>Pro</td><td> $29 / mo </td><td><span>10</span> users</td></tr></tbody></table>`);
    expect(extractText(doc.body)).toBe('Plan | Price\nPro | $29 / mo | 10 users');
  });

  it('keeps line breaks inside <pre>', () => {
    const doc = parse('<pre>line 1\n  line 2</pre>');
    expect(extractText(doc.body)).toBe('line 1\nline 2');
  });

  it('extracts a single element, including a table row', () => {
    const doc = parse('<div id="x"><span>A</span> <em>B</em></div><table><tr id="r"><td>1</td><td>2</td></tr></table>');
    expect(extractText(doc.getElementById('x')!)).toBe('A B');
    expect(extractText(doc.getElementById('r')!)).toBe('1 | 2');
  });

  it('gives the same text for the same markup, whatever the formatting', () => {
    const a = parse('<div><p>Hello   world</p><p>Bye</p></div>');
    const b = parse('<div>\n  <p>\n    Hello\n    world\n  </p>\n\n  <p>Bye</p>\n</div>');
    expect(extractText(a.body)).toBe(extractText(b.body));
  });
});
