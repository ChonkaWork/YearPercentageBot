// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import newsPage from '../e2e/fixtures/news.html?raw';
import { buildTextFragment, resolveDirective } from '../src/core/textFragment';
import { readPageMeta } from '../src/page/meta';
import { pageTextModel } from '../src/page/pageText';
import { $, render, selectRange } from './helpers';

function rangeOf(node: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range;
}

describe('pageTextModel', () => {
  it('collapses whitespace, separates blocks and marks the selection', () => {
    render('<h1>  Night   trains </h1>\n<p id="p">Sleepers <b>leave</b>\n  Vienna<br>at 19:40.</p><ul><li>One</li><li>Two</li></ul>');
    const model = pageTextModel(document, rangeOf($('#p')));
    expect(model?.text).toBe('Night trains\nSleepers leave Vienna\nat 19:40.\nOne\nTwo\n');
    expect(model && model.text.slice(model.start, model.end)).toBe('Sleepers leave Vienna\nat 19:40.');
  });

  it('skips what is not rendered, and keeps preformatted text', () => {
    render(
      '<p>Visible</p><p style="display:none">Hidden</p><script>var x = 1;</script><p><span style="visibility:hidden">Invisible</span> shown</p>' +
        '<pre id="code">a  =  1\nb = 2</pre><select><option>Option text</option></select>',
    );
    const model = pageTextModel(document, rangeOf($('#code')));
    expect(model?.text).toBe('Visible\nshown\na  =  1\nb = 2\n');
    expect(model && model.text.slice(model.start, model.end)).toBe('a  =  1\nb = 2');
  });

  it('maps offsets inside text nodes', () => {
    render('<p id="p">The sleeper from Vienna reaches Rome.</p>');
    const text = $('#p').firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 11);
    const model = pageTextModel(document, range);
    // The collapsed space before it may be included; buildTextFragment trims the edges.
    expect(model && model.text.slice(model.start, model.end).trim()).toBe('sleeper');
    expect(model && buildTextFragment(model).status === 'ok' && buildTextFragment(model)).toMatchObject({ fragment: 'text=sleeper' });
  });

  it('treats formulas as block boundaries', () => {
    render('<p id="p">The value <span class="katex"><span class="katex-html">x2</span></span> is large.</p>');
    const model = pageTextModel(document, rangeOf($('#p')));
    expect(model?.text).toBe('The value\nis large.\n');
  });
});

describe('deep links on the news page', () => {
  function renderNews(): void {
    const doc = new DOMParser().parseFromString(newsPage, 'text/html');
    render(doc.body.innerHTML, Array.from(doc.head.querySelectorAll('style')).map((style) => style.outerHTML).join(''));
  }

  it('links the minister’s quote in the body, not the same words in the standfirst', () => {
    renderNews();
    const quote = $('#minister-quote').firstChild as Text;
    selectRange(quote, 0, quote, quote.data.length);
    const range = window.getSelection()?.getRangeAt(0);
    const model = range ? pageTextModel(document, range) : null;
    expect(model).not.toBeNull();
    if (!model) return;
    const result = buildTextFragment(model);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.fragment).toBe('text=reporters%3A%20%E2%80%9C-,We%20are%20bringing%20the%20night%20train%20back');
    const found = resolveDirective(model.text, result.directive);
    expect(found?.start).toBe(model.start);
    // The same words appear earlier, in the standfirst.
    expect(model.text.indexOf('We are bringing the night train back')).toBeLessThan(model.start);
  });

  it('links a whole paragraph with textStart,textEnd', () => {
    renderNews();
    const range = rangeOf($('#closing'));
    const model = pageTextModel(document, range);
    expect(model).not.toBeNull();
    if (!model) return;
    const result = buildTextFragment(model);
    expect(result.status === 'ok' && result.fragment).toBe('text=Rail%20fans%20have,service%20in%20December.');
  });
});

describe('readPageMeta', () => {
  it('reads author, date, description and site from meta tags', () => {
    const doc = new DOMParser().parseFromString(newsPage, 'text/html');
    expect(readPageMeta(doc)).toMatchObject({
      title: 'Night trains return to Central Europe | The Daily Courier',
      author: 'Marta Nowak',
      published: '2026-09-14T07:30:00+02:00',
      description: 'Sleeper services link Vienna, Rome and Amsterdam again from December.',
      site: 'The Daily Courier',
    });
  });

  it('falls back to JSON-LD, microdata and <time>', () => {
    const ld = new DOMParser().parseFromString(
      '<title>Post</title><meta property="article:author" content="https://example.com/u/1"><script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","author":[{"@type":"Person","name":"Ada Lovelace"}],"datePublished":"2025-12-01"}]}</script><script type="application/ld+json">{broken</script>',
      'text/html',
    );
    expect(readPageMeta(ld)).toMatchObject({ author: 'Ada Lovelace', published: '2025-12-01' });
    const plain = new DOMParser().parseFromString('<title>x</title><article><a rel="author" href="/me">Grace Hopper</a><time datetime="2024-05-06">May 6</time></article>', 'text/html');
    expect(readPageMeta(plain)).toMatchObject({ author: 'Grace Hopper', published: '2024-05-06' });
  });
});
