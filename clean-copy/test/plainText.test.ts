// @vitest-environment jsdom
// Copied from Universal Copy with the converter it tests.
import { describe, expect, it } from 'vitest';
import { toPlainText, type PlainTextOptions } from '../src/core/plainText';
import { snapshotOf } from './helpers';

const plain = (html: string, options: PlainTextOptions = {}, head = '') => toPlainText(snapshotOf(html, head), options);

describe('toPlainText', () => {
  it('separates paragraphs and headings with a blank line and collapses whitespace', () => {
    expect(plain('<h2>  Title </h2>\n\n<p>First   paragraph\n with   spaces.</p>   <p>Second.</p>')).toBe('Title\n\nFirst paragraph with spaces.\n\nSecond.');
  });

  it('puts div-based lines on their own line without blank lines', () => {
    expect(plain('<div>Kyiv</div><div>Khreshchatyk 1</div><div>01001</div>')).toBe('Kyiv\nKhreshchatyk 1\n01001');
  });

  it('writes lists as "- item" and "1. item", nested lists indented', () => {
    expect(plain('<p>Intro</p><ul><li>One<ul><li>Sub</li></ul></li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol>')).toBe(
      'Intro\n\n- One\n  - Sub\n- Two\n\n1. First\n2. Second',
    );
  });

  it('keeps link text only by default and adds URLs when asked', () => {
    const html = '<p>Read <a href="/docs/guide?utm_source=x">the guide</a>, see <a href="https://example.com/">https://example.com/</a> or <a href="#top">top</a>.</p>';
    expect(plain(html)).toBe('Read the guide, see https://example.com/ or top.');
    expect(plain(html, { includeLinkUrls: true, pageUrl: 'https://example.com/docs/' })).toBe(
      'Read the guide (https://example.com/docs/guide), see https://example.com/ or top.',
    );
  });

  it('shows e-mail addresses of mailto links without the scheme', () => {
    expect(plain('<p><a href="mailto:hi@example.com">Write us</a></p>', { includeLinkUrls: true })).toBe('Write us (hi@example.com)');
  });

  it('removes invisible characters and no-break spaces', () => {
    expect(plain('<p>Zero​width space and soft­hyphen</p>')).toBe('Zerowidth space and softhyphen');
  });

  it('keeps code blocks verbatim', () => {
    expect(plain('<p>Run:</p><pre>npm install\n  --save-dev   x\n</pre><p>Done</p>')).toBe('Run:\n\nnpm install\n  --save-dev   x\n\nDone');
  });

  it('turns table rows into tab-separated lines', () => {
    expect(plain('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>two<br>lines</td></tr><tr><td colspan="2">wide</td></tr></table>')).toBe(
      'A\tB\n1\ttwo lines\nwide\t',
    );
  });

  it('keeps line breaks of pre-wrap text and emoji drawn as images', () => {
    expect(plain('<div style="white-space:pre-wrap">Hi team,\nsee you <img alt="👋" src="/e.png"> soon</div>')).toBe('Hi team,\nsee you 👋 soon');
  });

  it('drops Wikipedia edit links and footnote markers', () => {
    expect(plain('<h2>History<span class="mw-editsection">[<a href="/edit">edit</a>]</span></h2><p>Founded in 1991.<sup class="reference"><a href="#c1">[1]</a></sup><sup>[citation needed]</sup> Next.</p>')).toBe(
      'History\n\nFounded in 1991. Next.',
    );
  });

  it('writes task list checkboxes', () => {
    expect(plain('<ul><li><input type="checkbox" checked> Done</li><li><input type="checkbox">Todo</li></ul>')).toBe('- [x] Done\n- [ ] Todo');
  });

  it('can use single line breaks between paragraphs and another bullet', () => {
    expect(plain('<h2>Title</h2><p>One</p><ul><li>a<ul><li>b</li></ul></li></ul><p>Two</p>', { paragraphs: 'single', bullet: '•' })).toBe(
      'Title\nOne\n• a\n  • b\nTwo',
    );
  });
});
