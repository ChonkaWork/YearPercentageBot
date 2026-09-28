import { describe, expect, it } from 'vitest';
import { buildQuote } from '../src/core/quote';

const content = {
  markdown: 'Sleepers leave **Vienna** at 19:40.',
  text: 'Sleepers leave Vienna at 19:40.',
  html: '<p>Sleepers leave <strong>Vienna</strong> at 19:40.</p>',
};
const source = {
  title: 'Night trains return | The Daily Courier',
  url: 'https://news.example.com/travel/night-trains?utm_source=x#comments',
  fragment: 'text=Sleepers%20leave%20Vienna',
};
const link = 'https://news.example.com/travel/night-trains#:~:text=Sleepers%20leave%20Vienna';

describe('buildQuote', () => {
  it('Markdown: a blockquote, then — [title](link to the passage)', () => {
    const quote = buildQuote(content, source, 'markdown');
    expect(quote.link).toBe(link);
    expect(quote.payload.text).toBe(`> Sleepers leave **Vienna** at 19:40.\n\n— [Night trains return | The Daily Courier](${link})`);
  });

  it('plain text: “quote” — title, link', () => {
    expect(buildQuote(content, source, 'text').payload.text).toBe(`“Sleepers leave Vienna at 19:40.” — Night trains return | The Daily Courier, ${link}`);
  });

  it('rich editors get a <blockquote> and a link, whatever the text style', () => {
    const expected = `<blockquote cite="${link}">\n<p>Sleepers leave <strong>Vienna</strong> at 19:40.</p>\n</blockquote>\n<p>— <a href="${link}">Night trains return | The Daily Courier</a></p>`;
    expect(buildQuote(content, source, 'markdown').payload.html).toBe(expected);
    expect(buildQuote(content, source, 'text').payload.html).toBe(expected);
  });

  it('quotes several paragraphs line by line', () => {
    const quote = buildQuote({ markdown: 'First.\n\n- one\n- two', text: 'First.\n\n- one\n- two' }, source, 'markdown');
    expect(quote.payload.text).toBe(`> First.\n>\n> - one\n> - two\n\n— [Night trains return | The Daily Courier](${link})`);
    expect(buildQuote({ markdown: 'a\n\nb', text: 'a\n\nb' }, source, 'text').payload.text).toBe(`“a\n\nb”\n— Night trains return | The Daily Courier, ${link}`);
    expect(buildQuote({ markdown: 'a', text: 'a\n\nb <c>' }, source, 'text').payload.html).toContain('<p>a</p>\n<p>b &lt;c&gt;</p>');
  });

  it('escapes the title for Markdown and HTML, and keeps the link parseable', () => {
    const quote = buildQuote(content, { title: 'Q&A: [draft] <b>', url: 'https://example.com/wiki/Kyiv_(city)', fragment: 'text=a' }, 'markdown');
    expect(quote.payload.text).toBe('> Sleepers leave **Vienna** at 19:40.\n\n— [Q&A: \\[draft\\] \\<b>](https://example.com/wiki/Kyiv_(city)#:~:text=a)');
    expect(quote.payload.html).toContain('<a href="https://example.com/wiki/Kyiv_(city)#:~:text=a">Q&amp;A: [draft] &lt;b&gt;</a>');
  });

  it('links the page without a fragment when the passage can’t be targeted, and uses the address when there is no title', () => {
    const quote = buildQuote(content, { title: '', url: 'https://www.example.com/post', fragment: null }, 'markdown');
    expect(quote.link).toBe('https://www.example.com/post');
    expect(quote.payload.text).toBe('> Sleepers leave **Vienna** at 19:40.\n\n— [example.com/post](https://www.example.com/post)');
  });

  it('pages without a web address get the quote and the title only', () => {
    const quote = buildQuote(content, { title: 'Settings', url: 'chrome://settings', fragment: 'text=x' }, 'markdown');
    expect(quote.link).toBeNull();
    expect(quote.payload.text).toBe('> Sleepers leave **Vienna** at 19:40.\n\n— Settings');
    expect(buildQuote(content, { title: 'Settings', url: 'chrome://settings', fragment: null }, 'text').payload.text).toBe('“Sleepers leave Vienna at 19:40.” — Settings');
    expect(buildQuote(content, { title: '', url: '', fragment: null }, 'markdown').payload.text).toBe('> Sleepers leave **Vienna** at 19:40.');
  });
});
