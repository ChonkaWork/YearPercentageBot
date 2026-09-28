// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import blogPage from '../e2e/fixtures/article.html?raw';
import docsPage from '../e2e/fixtures/docs.html?raw';
import newsPage from '../e2e/fixtures/news.html?raw';
import mathPage from '../e2e/fixtures/math.html?raw';
import { extractArticle, hintWords } from '../src/core/article';
import { toMarkdown } from '../src/core/markdown';
import { el, type SnapNode } from '../src/core/snapshot';
import { snapshotDocument } from '../src/page/reader';
import { render } from './helpers';

/** Renders a fixture page (body and styles) and extracts its article as Markdown. */
function articleOf(html: string): { markdown: string; found: boolean; heading: string | null } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const styles = Array.from(doc.head.querySelectorAll('style')).map((style) => style.outerHTML).join('');
  render(doc.body.innerHTML, styles);
  const article = extractArticle(snapshotDocument(document).nodes);
  return { markdown: toMarkdown(article.nodes), found: article.found, heading: article.heading };
}

function expectNone(markdown: string, junk: string[]): void {
  for (const value of junk) expect(markdown, `no "${value}"`).not.toContain(value);
}

describe('extractArticle on real page layouts', () => {
  it('news page: the story with headline, standfirst, image and table; no masthead, ads, banners or sidebars', () => {
    const { markdown, found, heading } = articleOf(newsPage);
    expect(found).toBe(true);
    expect(heading).toBe('Night trains return to Central Europe');
    expect(markdown.startsWith('Travel\n\n# Night trains return to Central Europe\n\n“We are bringing the night train back,” the transport minister said')).toBe(true);
    expect(markdown).toContain('By [Marta Nowak](https://example.com/authors/marta-nowak) · 14 September 2026');
    expect(markdown).toContain('![A sleeper train at Vienna Central Station at dusk](https://example.com/images/sleeper.svg)');
    expect(markdown).toContain('## Why now');
    expect(markdown).toContain('Night train routes from December\n\n| Route              | Departs | Arrives | Couchette from |');
    expect(markdown).toContain('- Book a lower berth if you prefer to sit up in the evening.');
    expect(markdown.trimEnd().endsWith('plans to take the first Vienna to Rome service in December.')).toBe(true);
    expectNone(markdown, [
      'The Daily Courier', 'World', 'Business', 'Share', 'Advertisement', 'newsletter', 'Sign up', 'Topics:', 'Related stories',
      'Eurostar', 'Comments (42)', 'Most read', 'comet', 'We use cookies', 'Accept', '© 2026',
    ]);
  });

  it('docs page: the article with code, callout and table; no navigation, table of contents or feedback', () => {
    const { markdown, found } = articleOf(docsPage);
    expect(found).toBe(true);
    expect(markdown).toBe(
      [
        '# Storing data',
        "The `acme.storage` API saves settings and larger records on the user's device. Data survives restarts, and nothing leaves the device unless you sync it yourself.",
        "**Note:** storage is per profile. Two browser profiles never see each other's data.",
        '## Save and read a value',
        'Every call returns a promise. Keys are strings; values can be anything that survives `structuredClone`.',
        "```js\nawait acme.storage.set({ theme: 'dark' });\nconst { theme } = await acme.storage.get('theme');\nconsole.log(theme); // \"dark\"\n```",
        '## Limits',
        'Each area has its own quota. Writes that go over it fail with `QuotaExceededError`, and nothing is written.',
        '| Area      | Quota  | Synced                 |\n| --------- | ------ | ---------------------- |\n| `local`   | 10 MB  | No                     |\n| `sync`    | 100 KB | Yes                    |\n| `session` | 10 MB  | No, cleared on restart |',
        '## Next steps',
        '- Read about [messaging](https://example.com/guide/messaging) to share stored data between the parts of your app.\n- Use the [test helpers](https://example.com/guide/testing) to reset storage between tests.',
      ].join('\n\n'),
    );
  });

  it('blog post: the article, without the share bar, hidden ads and the footer', () => {
    const { markdown } = articleOf(blogPage);
    expect(markdown.startsWith('# Shipping a Chrome extension in 2026\n\nBy [Anna Kowalski](https://example.com/authors/anna) · March 3')).toBe(true);
    expect(markdown).toContain("```js\nchrome.runtime.onInstalled.addListener(() => {\n  console.log('installed');\n});\n```");
    expect(markdown).toContain('> Ship small, ship often.  \n> Then measure.');
    expectNone(markdown, ['Tweet', 'Advertisement', 'Subscribe', 'Back to top', '© 2026']);
  });

  it('lecture notes: formulas come through as LaTeX', () => {
    const { markdown } = articleOf(mathPage);
    expect(markdown).toContain('A simple linear model predicts $\\hat{y} = \\beta_0 + \\beta_1 x$ from a single input $x$.');
    expect(markdown).toContain('$$\nR^2 = 1 - \\frac{\\mathrm{SS}_{\\text{res}}}{\\mathrm{SS}_{\\text{tot}}}\n$$');
    expectNone(markdown, ['Statistics 101 · Week 4']);
  });

  it('adds the headline when it sits above the article container', () => {
    const { markdown } = articleOf(`
      <header class="site-header"><a href="/">Home</a> <a href="/blog">Blog</a></header>
      <h1>Release notes 4.2</h1>
      <div class="post-body">
        <p>Version 4.2 brings faster sync, a new export dialog and many small fixes, thanks to everyone who reported bugs.</p>
        <p>Sync now resumes after a lost connection, and exports keep your folder structure, including empty folders.</p>
      </div>
      <div class="sidebar"><p>Popular posts, archives and a long list of tags that are not part of the article at all.</p></div>`);
    expect(markdown).toBe(
      '# Release notes 4.2\n\nVersion 4.2 brings faster sync, a new export dialog and many small fixes, thanks to everyone who reported bugs.\n\nSync now resumes after a lost connection, and exports keep your folder structure, including empty folders.',
    );
  });

  it('merges an article split over sibling blocks, and drops link lists inside it', () => {
    const paragraph = (text: string) => `<p>${text} ${'This sentence adds enough words, commas, and length to count as real content. '.repeat(2)}</p>`;
    const { markdown } = articleOf(`
      <div id="page">
        <div class="part">${paragraph('Part one.')}${paragraph('More of part one.')}</div>
        <div class="part">${paragraph('Part two.')}${paragraph('More of part two.')}</div>
        <div><ul><li><a href="/a">Read next: one</a></li><li><a href="/b">Read next: two</a></li><li><a href="/c">Read next: three</a></li></ul></div>
      </div>`);
    expect(markdown).toContain('Part one.');
    expect(markdown).toContain('Part two.');
    expect(markdown).not.toContain('Read next');
  });

  it('falls back to the cleaned page when nothing stands out', () => {
    const { markdown, found } = articleOf('<nav><a href="/">Home</a></nav><p>Short note.</p><footer>Footer</footer>');
    expect(found).toBe(false);
    expect(markdown).toBe('Short note.');
  });
});

describe('hints', () => {
  it('splits ids and classes into names, with roles and fixed position', () => {
    expect(hintWords('mainNav', 'site-nav__item  shareBar', 'navigation', true)).toBe('main-nav site-nav-item share-bar @navigation @fixed');
    expect(hintWords(null, null, null, false)).toBe('');
  });

  it('reads a name by its last word: main-nav is navigation, post-content is content', () => {
    const page = (k: string): SnapNode[] => [
      el('div', null, { ...el('div', null, el('p', null, 'Kept paragraph with enough text to count, and a comma.')), k: 'post-content' }, { ...el('div', null, el('p', null, 'Dropped block')), k }),
    ];
    for (const junk of ['main-nav', 'article-footer', 'ad-free', 'cookie-banner', '@complementary', '@fixed']) {
      expect(toMarkdown(extractArticle(page(junk)).nodes)).toBe('Kept paragraph with enough text to count, and a comma.');
    }
    const kept = extractArticle([el('div', null, { ...el('div', null, el('p', null, 'Body text that is long enough to be scored, with commas, yes.')), k: 'sidebar-content' })]);
    expect(toMarkdown(kept.nodes)).toContain('Body text');
  });
});
