import { describe, expect, it } from 'vitest';
import { convertTable } from '../src/core/convert';
import { normalizeTree } from '../src/core/normalize';
import { plainCellText } from '../src/core/plainText';
import { defaultSettings } from '../src/core/settings';
import { el, type SnapElement } from '../src/core/snapshot';
import { buildTableModel, combineHeaderRows, extractTableData, layoutGrid, type TableData } from '../src/core/table';
import { columnKeys, neutralizeFormula, toCsv, toHtmlTable, toJson, toTsv } from '../src/core/tableFormats';

const td = (value: string | SnapElement, attrs: { colspan?: number; rowspan?: number } = {}) => el('td', attrs, value);
const th = (value: string, attrs: { colspan?: number; rowspan?: number } = {}) => el('th', attrs, value);
const tr = (...cells: SnapElement[]) => el('tr', null, ...cells);

function data(table: SnapElement): TableData {
  const [normalized] = normalizeTree([table]) as SnapElement[];
  return extractTableData(buildTableModel(normalized!), (cell) => plainCellText(cell));
}

describe('layoutGrid', () => {
  const layout = (rows: number[][][]) =>
    layoutGrid([rows], ([colSpan, rowSpan]: number[]) => ({ colSpan: colSpan ?? 1, rowSpan: rowSpan ?? 1 }));

  it('expands colspan and rowspan into a rectangular grid', () => {
    // A spans 2 columns; B spans 2 rows.
    const grid = layout([[[2, 1], [1, 2]], [[1, 1], [1, 1]]]);
    expect(grid.width).toBe(3);
    expect(grid.rows.map((row) => row.map((slot) => (slot ? (slot.origin ? 'O' : 's') : '.')).join(''))).toEqual(['OsO', 'OOs']);
  });

  it('pads ragged rows and clips rowspan at the end of the row group', () => {
    const grid = layoutGrid([[['a', 'b'], ['c']], [['d']]], (cell: string) => ({ colSpan: 1, rowSpan: cell === 'b' ? 5 : 1 }));
    expect(grid.rows.map((row) => row.map((slot) => slot?.cell ?? '.').join(''))).toEqual(['ab', 'cb', 'd.']);
  });

  it('treats rowspan=0 as "to the end of the group" and survives absurd spans', () => {
    const grid = layoutGrid([[['a', 'b'], ['c'], ['d']]], (cell: string) =>
      cell === 'a' ? { colSpan: 1, rowSpan: 0 } : cell === 'b' ? { colSpan: 1e9, rowSpan: 1 } : { colSpan: 1, rowSpan: 1 },
    );
    expect(grid.width).toBe(1000); // capped at MAX_COLUMNS
    expect(grid.rows.map((row) => row[0]?.cell)).toEqual(['a', 'a', 'a']);
    expect(grid.rows[1]?.[1]?.cell).toBe('c');
  });
});

describe('header detection', () => {
  it('uses <thead> rows', () => {
    const table = el('table', null, el('thead', null, tr(th('Name'), th('Age'))), el('tbody', null, tr(td('Ann'), td('31'))));
    expect(buildTableModel(table).headerRows).toBe(1);
  });

  it('uses leading rows of <th> without a <thead>', () => {
    const table = el('table', null, el('tbody', null, tr(th('Name'), th('Age')), tr(th('Ann'), td('31'))));
    expect(buildTableModel(table).headerRows).toBe(1);
  });

  it('treats a first row of bold cells as a header', () => {
    const bold = (value: string) => td(el('b', null, value));
    const table = el('table', null, el('tbody', null, tr(bold('Plan'), bold('Price')), tr(td('Free'), td('$0'))));
    expect(buildTableModel(table).headerRows).toBe(1);
  });

  it('finds no header in a plain grid', () => {
    const table = el('table', null, el('tbody', null, tr(td('a'), td('b')), tr(td('c'), td('d'))));
    expect(buildTableModel(table).headerRows).toBe(0);
  });

  it('orders thead first and tfoot last, like HTMLTableElement.rows', () => {
    const table = el(
      'table',
      null,
      el('tfoot', null, tr(td('Total'), td('3'))),
      el('tbody', null, tr(td('x'), td('3'))),
      el('thead', null, tr(th('Item'), th('Qty'))),
    );
    expect(data(table).rows).toEqual([['Item', 'Qty'], ['x', '3'], ['Total', '3']]);
  });
});

describe('extractTableData', () => {
  it('repeats spanned values, drops empty rows and trailing empty columns', () => {
    const table = el(
      'table',
      null,
      el('thead', null, tr(th('Region', { rowspan: 2 }), th('Population', { colspan: 2 }), th('')), tr(th('2010'), th('2020'))),
      el('tbody', null, tr(td('North'), td('1,200'), td('1,350'), td('')), tr(td(''), td(''), td(''), td('')), tr(td('South', { colspan: 3 }))),
    );
    const result = data(table);
    expect(result.headerRows).toBe(2);
    expect(result.rows).toEqual([
      ['Region', 'Population', 'Population'],
      ['Region', '2010', '2020'],
      ['North', '1,200', '1,350'],
      ['South', 'South', 'South'],
    ]);
    expect(combineHeaderRows(result)).toEqual(['Region', 'Population / 2010', 'Population / 2020']);
  });

  it('keeps line breaks inside cells and uses image alt text for icon-only cells', () => {
    const table = el('table', null, tr(td(el('p', null, 'First line')), td(el('img', { alt: 'Yes', src: 'https://x/y.png' }))));
    (table.c[0] as SnapElement).c[0] = td(el('div', null, el('p', null, 'First line'), el('p', null, 'Second line')));
    expect(data(table).rows).toEqual([['First line\nSecond line', 'Yes']]);
  });

  it('keeps a nested table inside its cell instead of mixing it into the outer grid', () => {
    const inner = el('table', null, tr(td('i1'), td('i2')), tr(td('i3'), td('i4')));
    const table = el('table', null, tr(th('Outer'), th('Detail')), tr(td('o1'), td(inner)));
    const result = data(table);
    expect(result.width).toBe(2);
    expect(result.rows[1]).toEqual(['o1', 'i1 i2\ni3 i4']);
  });
});

describe('CSV', () => {
  const sample: TableData = {
    rows: [['Name', 'Quote', 'Notes'], ['Smith, John', 'He said "hi"', 'line 1\nline 2'], ['Plain', '', '1;2']],
    headerRows: 1,
    width: 3,
    truncated: false,
  };

  it('quotes fields with commas, quotes and line breaks (RFC 4180)', () => {
    expect(toCsv(sample)).toBe('Name,Quote,Notes\n"Smith, John","He said ""hi""","line 1\nline 2"\nPlain,,1;2');
  });

  it('supports semicolons for Excel locales that use a decimal comma', () => {
    expect(toCsv(sample, ';')).toBe('Name;Quote;Notes\nSmith, John;"He said ""hi""";"line 1\nline 2"\nPlain;;"1;2"');
  });
});

describe('TSV', () => {
  it('quotes cells with line breaks like Excel does, replaces tabs, leaves plain quotes alone', () => {
    const tsv = toTsv({ rows: [['a\tb', 'x\ny', 'say "hi"', '"quoted" start']], headerRows: 0, width: 4, truncated: false });
    expect(tsv).toBe('a b\t"x\ny"\tsay "hi"\t"""quoted"" start"');
  });

  it('neutralizes cells that spreadsheets would run as formulas, but not numbers', () => {
    expect(neutralizeFormula('=HYPERLINK("http://evil","x")')).toBe(`'=HYPERLINK("http://evil","x")`);
    expect(neutralizeFormula('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(neutralizeFormula('-2+3+cmd|x')).toBe(`'-2+3+cmd|x`);
    for (const value of ['-5', '+380 44 123 45 67', '-12.5%', '-', '1,234', 'Hello']) expect(neutralizeFormula(value)).toBe(value);
  });

  it('builds an escaped HTML table with header cells for spreadsheet paste', () => {
    const html = toHtmlTable({ rows: [['<b>Name</b>', 'Age'], ['Ann & Bob', 'a\nb']], headerRows: 1, width: 2, truncated: false });
    expect(html).toBe(
      '<table><thead><tr><th>&lt;b&gt;Name&lt;/b&gt;</th><th>Age</th></tr></thead><tbody><tr><td>Ann &amp; Bob</td><td>a<br>b</td></tr></tbody></table>',
    );
  });
});

describe('JSON', () => {
  it('keys rows by header, deduplicates duplicate and empty names, keeps column order', () => {
    const table: TableData = {
      rows: [['Name', '2020', 'Name', '', '2010', 'Name 2'], ['Ann', '5', 'A.', 'x', '4', 'y']],
      headerRows: 1,
      width: 6,
      truncated: false,
    };
    expect(columnKeys(table)).toEqual(['Name', '2020', 'Name 2', 'Column 4', '2010', 'Name 2 2']);
    const json = toJson(table);
    expect(json.indexOf('"2020"')).toBeLessThan(json.indexOf('"2010"'));
    expect(JSON.parse(json)).toEqual([{ Name: 'Ann', '2020': '5', 'Name 2': 'A.', 'Column 4': 'x', '2010': '4', 'Name 2 2': 'y' }]);
  });

  it('uses "Column N" keys without a header and escapes values', () => {
    const json = toJson({ rows: [['a "q"', 'line\nbreak']], headerRows: 0, width: 2, truncated: false });
    expect(JSON.parse(json)).toEqual([{ 'Column 1': 'a "q"', 'Column 2': 'line\nbreak' }]);
  });
});

describe('convertTable', () => {
  const table = el(
    'table',
    null,
    el('thead', null, tr(th('Feature'), th('Notes'))),
    el('tbody', null, tr(td(el('a', { href: 'https://example.com/a' }, 'Links')), td('a | b\nc'))),
  );

  it('produces every format', () => {
    const settings = defaultSettings('en-US');
    expect(convertTable(table, 'csv', settings).payload.text).toBe('Feature,Notes\nLinks,a | b c');
    const tsv = convertTable(table, 'tsv', settings);
    expect(tsv.payload.text).toBe('Feature\tNotes\nLinks\ta | b c');
    expect(tsv.payload.html).toContain('<th>Feature</th>');
    expect(convertTable(table, 'markdown', settings).payload.text).toBe(
      '| Feature                        | Notes    |\n| ------------------------------ | -------- |\n| [Links](https://example.com/a) | a \\| b c |',
    );
    expect(JSON.parse(convertTable(table, 'json', settings).payload.text)).toEqual([{ Feature: 'Links', Notes: 'a | b c' }]);
    expect(convertTable(table, 'csv', settings)).toMatchObject({ rows: 2, columns: 2 });
  });

  it('uses the configured CSV delimiter', () => {
    expect(convertTable(table, 'csv', { ...defaultSettings(), csvDelimiter: ';' }).payload.text).toBe('Feature;Notes\nLinks;a | b c');
  });
});
