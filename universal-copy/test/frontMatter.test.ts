import { describe, expect, it } from 'vitest';
import {
  checkTemplate,
  DEFAULT_FRONT_MATTER_TEMPLATE,
  frontMatterValues,
  isoDate,
  normalizeDate,
  parseTags,
  renderFrontMatter,
  SAMPLE_VALUES,
  withFrontMatter,
  type PageMeta,
} from '../src/core/frontMatter';

const meta: PageMeta = {
  title: 'Night trains return to Central Europe | The Daily Courier',
  url: 'https://news.example.com/travel/night-trains?utm_source=newsletter&id=4',
  author: 'Marta Nowak',
  published: '2026-09-14T07:30:00+02:00',
  description: 'Sleeper services link Vienna, Rome and Amsterdam again.',
  site: 'The Daily Courier',
};
const now = new Date(2026, 8, 28, 10, 30);

describe('front matter', () => {
  it('renders the default template with values escaped by type', () => {
    expect(renderFrontMatter(DEFAULT_FRONT_MATTER_TEMPLATE, frontMatterValues(meta, 'clippings, travel', now))).toBe(
      [
        '---',
        'title: "Night trains return to Central Europe | The Daily Courier"',
        'url: https://news.example.com/travel/night-trains?id=4',
        'author: "Marta Nowak"',
        'published: 2026-09-14',
        'clipped: 2026-09-28',
        'tags: [clippings, travel]',
        '---',
        '',
      ].join('\n'),
    );
  });

  it('leaves out lines whose only value is empty', () => {
    const values = frontMatterValues({ ...meta, author: '', published: 'sometime' }, '', now);
    const block = renderFrontMatter(DEFAULT_FRONT_MATTER_TEMPLATE, values);
    expect(block).not.toContain('author:');
    expect(block).not.toContain('published:');
    expect(block).not.toContain('tags:');
    expect(block).toContain('clipped: 2026-09-28');
  });

  it('keeps values from breaking out of YAML', () => {
    const values = frontMatterValues({ ...meta, title: 'Say "hi"\n---\nevil: true', author: 'C:\\Users\\me' }, '', now);
    const block = renderFrontMatter('title: {{title}}\nauthor: {{author}}', values);
    expect(block).toBe('---\ntitle: "Say \\"hi\\" --- evil: true"\nauthor: "C:\\\\Users\\\\me"\n---\n');
  });

  it('supports variables inside other text and quoted strings, and leaves unknown ones', () => {
    const values = frontMatterValues(meta, 'reading list, #rail', now);
    const block = renderFrontMatter('aliases: ["Clip: {{title}}"]\nsource: {{site}} ({{url}})\nnote: {{nope}}\ntags:\n  - web\ncategory: [{{tags}}]', values);
    expect(block).toBe(
      [
        '---',
        'aliases: ["Clip: Night trains return to Central Europe | The Daily Courier"]',
        'source: The Daily Courier (https://news.example.com/travel/night-trains?id=4)',
        'note: {{nope}}',
        'tags:',
        '  - web',
        'category: [reading-list, rail]',
        '---',
        '',
      ].join('\n'),
    );
  });

  it('accepts templates with or without --- fences, and nothing for an empty one', () => {
    const values = frontMatterValues(meta, '', now);
    expect(renderFrontMatter('---\ntitle: {{title}}\n---\n', values)).toBe(renderFrontMatter('title: {{title}}', values));
    expect(renderFrontMatter('', values)).toBe('');
    expect(renderFrontMatter('author: {{author}}', { ...values, author: '' })).toBe('');
  });

  it('quotes values YAML would read as another type', () => {
    const block = renderFrontMatter('tags: {{tags}}\nurl: {{url}}', { tags: ['2026', 'true', 'rail', 'a b'], url: 'https://example.com/a b' });
    expect(block).toBe('---\ntags: ["2026", "true", rail, "a b"]\nurl: "https://example.com/a b"\n---\n');
  });

  it('puts the block before the Markdown with one blank line', () => {
    expect(withFrontMatter('---\na: 1\n---\n', '\n# Title')).toBe('---\na: 1\n---\n\n# Title');
    expect(withFrontMatter('', '# Title')).toBe('# Title');
  });
});

describe('values', () => {
  it('normalizes dates', () => {
    expect(normalizeDate('2026-03-03')).toBe('2026-03-03');
    expect(normalizeDate('2026-03-03T23:30:00-05:00')).toBe('2026-03-03');
    expect(normalizeDate('March 3, 2026')).toBe('2026-03-03');
    expect(normalizeDate('3 hours ago')).toBe('');
    expect(normalizeDate('20260303')).toBe('');
    expect(normalizeDate(undefined)).toBe('');
    expect(isoDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('parses tags the way note apps accept them', () => {
    expect(parseTags('clippings, reading list; #travel,,  Київ ,clippings')).toEqual(['clippings', 'reading-list', 'travel', 'Київ']);
    expect(parseTags('')).toEqual([]);
  });

  it('cleans the page values', () => {
    const values = frontMatterValues({ ...meta, title: '  Line\none  ', url: 'chrome://settings' }, 'x', now);
    expect(values.title).toBe('Line one');
    expect(values.url).toBe('');
  });
});

describe('checkTemplate', () => {
  it('accepts the default template', () => {
    expect(checkTemplate(DEFAULT_FRONT_MATTER_TEMPLATE)).toEqual([]);
    expect(checkTemplate('# a comment\n\ntags:\n  - web\n- item')).toEqual([]);
  });

  it('points at unknown variables, broken braces, bad lines and repeated keys', () => {
    const issues = checkTemplate('title: {{titel}}\nurl: {{url}\njust text\ntitle: again');
    expect(issues.map((issue) => issue.line)).toEqual([1, 2, 3, 4]);
    expect(issues[0]?.message).toMatch(/^Unknown variable \{\{titel\}\}\. Available: title, url, author/);
    expect(issues[1]?.message).toBe('A variable is missing its {{ or }}.');
    expect(issues[2]?.message).toBe('Each line needs a name and a value, like "source: {{url}}".');
    expect(issues[3]?.message).toBe('"title" is already set on line 1.');
  });

  it('has sample values for the preview', () => {
    expect(renderFrontMatter(DEFAULT_FRONT_MATTER_TEMPLATE, SAMPLE_VALUES)).toContain('title: "Night trains return to Central Europe"');
  });
});
