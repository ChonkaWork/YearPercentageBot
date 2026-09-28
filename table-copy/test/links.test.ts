import { describe, expect, it } from 'vitest';
import { pickColumns } from '../src/core/columns';
import { tableDataFromSnapshot } from '../src/core/extract';
import { formatTable, toMarkdown } from '../src/core/formats';
import { expandLinks, linkColumns, markdownUrl, singleLinkUrl, withoutLinks } from '../src/core/links';
import { el } from '../src/core/snapshot';
import type { TableData } from '../src/core/table';
import { table } from './helpers';

const a = (href: string, text: string) => el('a', { href }, text);

describe('singleLinkUrl', () => {
  it('returns the URL when the whole cell is one http(s) link', () => {
    expect(singleLinkUrl(el('td', null, a('https://example.com/a', 'A')))).toBe('https://example.com/a');
    expect(singleLinkUrl(el('td', null, ' ', el('b', null, a('http://example.com/b', 'B')), ' '))).toBe('http://example.com/b');
    expect(singleLinkUrl(el('td', null, a('https://example.com/i', ''), el('span', null, ' ')))).toBe('https://example.com/i');
    // An <a> without href is plain text next to the link.
    expect(singleLinkUrl(el('td', null, a('https://example.com/i', 'I'), el('a', null, 'note')))).toBe('');
  });

  it('ignores cells with text or images besides the link, several links, and other schemes', () => {
    expect(singleLinkUrl(el('td', null, 'See ', a('https://example.com/a', 'A')))).toBe('');
    expect(singleLinkUrl(el('td', null, a('https://example.com/a', 'A'), ', ', a('https://example.com/b', 'B')))).toBe('');
    expect(singleLinkUrl(el('td', null, el('img', { alt: 'flag' }), a('https://example.com/a', 'A')))).toBe('');
    expect(singleLinkUrl(el('td', null, a('mailto:ann@example.com', 'Ann')))).toBe('');
    expect(singleLinkUrl(el('td', null, 'plain'))).toBe('');
  });
});

const linked: TableData = {
  rows: [
    ['Name', 'Team', 'Score'],
    ['Ann', 'Red', '10'],
    ['Bob', 'Blue', '7'],
  ],
  headerRows: 1,
  width: 3,
  truncated: false,
  links: [
    ['https://example.com/sort?by=name', '', ''],
    ['https://example.com/ann', '', ''],
    ['', 'https://example.com/teams/blue', ''],
  ],
};

describe('expandLinks', () => {
  it('adds a "<Column> URL" column after each column with links in its body (header links ignored)', () => {
    expect(linkColumns(linked)).toEqual([0, 1]);
    expect(expandLinks(linked)).toEqual({
      rows: [
        ['Name', 'Name URL', 'Team', 'Team URL', 'Score'],
        ['Ann', 'https://example.com/ann', 'Red', '', '10'],
        ['Bob', '', 'Blue', 'https://example.com/teams/blue', '7'],
      ],
      headerRows: 1,
      width: 5,
      truncated: false,
    });
  });

  it('names URL columns after the combined header, and "Column N" without one', () => {
    const grouped: TableData = { rows: [['Region', 'Population'], ['Region', '2010'], ['North', '1']], headerRows: 2, width: 2, truncated: false, links: [['', ''], ['', ''], ['', 'https://example.com/n']] };
    expect(expandLinks(grouped).rows.slice(0, 2)).toEqual([
      ['Region', 'Population', ''],
      ['Region', '2010', 'Population / 2010 URL'],
    ]);
    const bare: TableData = { rows: [['x']], headerRows: 0, width: 1, truncated: false, links: [['https://example.com/x']] };
    expect(expandLinks(bare).rows).toEqual([['x', 'https://example.com/x']]);
    const empty: TableData = { rows: [['H'], ['']], headerRows: 1, width: 1, truncated: false, links: [['https://example.com/h'], ['']] };
    expect(expandLinks(empty)).toEqual({ rows: [['H'], ['']], headerRows: 1, width: 1, truncated: false });
  });

  it('drops link data when Keep links is off', () => {
    expect(withoutLinks(linked).links).toBeUndefined();
    expect(withoutLinks(linked).rows).toBe(linked.rows);
  });
});

describe('formats with Keep links', () => {
  const on = { csvDelimiter: ',' as const, keepLinks: true };
  const off = { csvDelimiter: ',' as const, keepLinks: false };

  it('CSV, TSV and JSON get URL columns; nothing changes when the setting is off', () => {
    expect(formatTable(linked, 'csv', on).text).toBe('Name,Name URL,Team,Team URL,Score\nAnn,https://example.com/ann,Red,,10\nBob,,Blue,https://example.com/teams/blue,7');
    expect(formatTable(linked, 'csv', off).text).toBe('Name,Team,Score\nAnn,Red,10\nBob,Blue,7');
    expect(formatTable(linked, 'tsv', on).text.split('\n')[0]).toBe('Name\tName URL\tTeam\tTeam URL\tScore');
    expect(formatTable(linked, 'tsv', on).html).toContain('<th>Name URL</th>');
    expect(JSON.parse(formatTable(linked, 'json', on).text)[0]).toEqual({ Name: 'Ann', 'Name URL': 'https://example.com/ann', Team: 'Red', 'Team URL': '', Score: '10' });
  });

  it('Markdown writes [text](url) in place', () => {
    expect(formatTable(linked, 'markdown', on).text).toBe(
      [
        '| Name                           | Team                                   | Score |',
        '| ------------------------------ | -------------------------------------- | ----- |',
        '| [Ann](https://example.com/ann) | Red                                    | 10    |',
        '| Bob                            | [Blue](https://example.com/teams/blue) | 7     |',
      ].join('\n'),
    );
    expect(formatTable(linked, 'markdown', off).text).not.toContain('](');
  });

  it('escapes link text and encodes the destination', () => {
    const tricky: TableData = { rows: [['H'], ['a [b] | c']], headerRows: 1, width: 1, truncated: false, links: [[''], ['https://example.com/wiki/Foo_(bar)']] };
    expect(toMarkdown(tricky).split('\n')[2]).toBe('| [a \\[b\\] \\| c](https://example.com/wiki/Foo_%28bar%29) |');
    const imageOnly: TableData = { rows: [['H'], ['']], headerRows: 1, width: 1, truncated: false, links: [[''], ['https://example.com/x']] };
    expect(toMarkdown(imageOnly).split('\n')[2]).toContain('[https://example.com/x](https://example.com/x)');
    expect(markdownUrl('https://e.com/a b<c>')).toBe('https://e.com/a%20b%3Cc%3E');
  });

  it('reads links from a table snapshot, repeating them across spans like the values', () => {
    const snapshot = el(
      'table',
      null,
      el('tr', null, el('th', null, 'Name'), el('th', null, 'Home')),
      el('tr', null, el('td', null, a('https://example.com/ann', 'Ann')), el('td', { rowspan: 2 }, a('https://example.com/kyiv', 'Kyiv'))),
      el('tr', null, el('td', null, 'Bob')),
    );
    const data = tableDataFromSnapshot(snapshot);
    expect(data.links).toEqual([
      ['', ''],
      ['https://example.com/ann', 'https://example.com/kyiv'],
      ['', 'https://example.com/kyiv'],
    ]);
    expect(tableDataFromSnapshot(el('table', null, el('tr', null, el('td', null, 'a'), el('td', null, 'b')))).links).toBeUndefined();
  });

  it('keeps links lined up when columns are picked', () => {
    const picked = pickColumns(linked, [1, 0]);
    expect(picked.links).toEqual([
      ['', 'https://example.com/sort?by=name'],
      ['', 'https://example.com/ann'],
      ['https://example.com/teams/blue', ''],
    ]);
    expect(pickColumns(linked, [2]).links).toBeUndefined();
    expect(pickColumns(table([['a', 'b'], ['1', '2']]), [1]).links).toBeUndefined();
  });
});
