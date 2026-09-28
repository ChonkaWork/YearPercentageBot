import type { PageMeta } from '../core/frontMatter';

/**
 * What a page says about itself, for front matter: author and publication date from meta
 * tags, schema.org data (JSON-LD or microdata), a rel=author link or the first <time> in the
 * article. Only reads; values are cleaned and escaped in src/core/frontMatter.ts.
 */

function metaContent(doc: Document, ...names: string[]): string {
  for (const name of names) {
    const element = doc.querySelector(`meta[name="${name}" i], meta[property="${name}" i], meta[itemprop="${name}" i]`);
    const value = element?.getAttribute('content')?.trim();
    if (value) return value;
  }
  return '';
}

function squash(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** schema.org objects from JSON-LD blocks (@graph flattened). JSON.parse only: nothing runs. */
function jsonLd(doc: Document): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      out.push(record);
      if (record['@graph']) add(record['@graph']);
    }
  };
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10)) {
    try {
      add(JSON.parse(script.textContent ?? ''));
    } catch {
      // Broken JSON-LD is common; ignore it.
    }
  }
  return out;
}

function nameOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(nameOf).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>).name;
    return typeof name === 'string' ? name : '';
  }
  return '';
}

const ARTICLE_TYPES = /Article|BlogPosting|Report|TechArticle|WebPage/i;

export function readPageMeta(doc: Document = document): PageMeta {
  const ld = jsonLd(doc).filter((item) => ARTICLE_TYPES.test(String(item['@type'] ?? '')));
  const ldAuthor = ld.map((item) => nameOf(item.author)).find(Boolean) ?? '';
  const ldDate = ld.map((item) => item.datePublished).find((value): value is string => typeof value === 'string') ?? '';

  let author = metaContent(doc, 'author', 'article:author', 'parsely-author', 'dc.creator', 'twitter:creator');
  // article:author is often a profile URL; a name reads better.
  if (/^https?:\/\//i.test(author)) author = '';
  author ||=
    ldAuthor ||
    squash(doc.querySelector('[itemprop="author"] [itemprop="name"], [itemprop="author"]')?.textContent) ||
    squash(doc.querySelector('a[rel~="author"], [rel~="author"]')?.textContent);

  const time = doc.querySelector('article time[datetime], main time[datetime], time[datetime][itemprop="datePublished"], time[datetime]');
  const published =
    metaContent(doc, 'article:published_time', 'datePublished', 'date', 'dc.date', 'dc.date.issued', 'pubdate', 'publish-date', 'sailthru.date') ||
    ldDate ||
    doc.querySelector('[itemprop="datePublished"]')?.getAttribute('datetime') ||
    doc.querySelector('[itemprop="datePublished"]')?.getAttribute('content') ||
    time?.getAttribute('datetime') ||
    '';

  return {
    title: doc.title || metaContent(doc, 'og:title'),
    url: doc.location?.href ?? '',
    author: squash(author).slice(0, 300),
    published: published.trim().slice(0, 100),
    description: squash(metaContent(doc, 'description', 'og:description', 'twitter:description')).slice(0, 1000),
    site: squash(metaContent(doc, 'og:site_name', 'application-name')).slice(0, 300),
  };
}
