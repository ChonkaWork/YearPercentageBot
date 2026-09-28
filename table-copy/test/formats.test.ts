import { describe, expect, it } from 'vitest';
import { columnKeys, EXPORT_FORMATS, FILE_TYPES, fileName, fileText, formatTable, isExportFormat, markdownCell, neutralizeFormula, toCsv, toHtmlTable, toJson, toMarkdown, toTsv } from '../src/core/formats';
import { table } from './helpers';

const sample = table([
  ['Name', 'Quote', 'Notes'],
  ['Smith, John', 'He said "hi"', 'line 1\nline 2'],
  ['Plain', '', '1;2'],
]);

describe('CSV', () => {
  it('quotes fields with commas, quotes and line breaks (RFC 4180)', () => {
    expect(toCsv(sample)).toBe('Name,Quote,Notes\n"Smith, John","He said ""hi""","line 1\nline 2"\nPlain,,1;2');
  });

  it('supports semicolons for Excel locales that use a decimal comma', () => {
    expect(toCsv(sample, ';')).toBe('Name;Quote;Notes\nSmith, John;"He said ""hi""";"line 1\nline 2"\nPlain;;"1;2"');
  });

  it('never rewrites values (CSV is data): formulas stay as they are', () => {
    expect(toCsv(table([['=SUM(A1)', '-5']], 0))).toBe('=SUM(A1),-5');
  });
});

describe('TSV', () => {
  it('quotes cells with line breaks like Excel does, replaces tabs, leaves plain quotes alone', () => {
    expect(toTsv(table([['a\tb', 'x\ny', 'say "hi"', '"quoted" start']], 0))).toBe('a b\t"x\ny"\tsay "hi"\t"""quoted"" start"');
  });

  it('neutralizes cells that spreadsheets would run as formulas, but not numbers', () => {
    expect(neutralizeFormula('=HYPERLINK("http://evil","x")')).toBe(`'=HYPERLINK("http://evil","x")`);
    expect(neutralizeFormula('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(neutralizeFormula('-2+3+cmd|x')).toBe(`'-2+3+cmd|x`);
    for (const value of ['-5', '+380 44 123 45 67', '-12.5%', '-', '1,234', 'Hello']) expect(neutralizeFormula(value)).toBe(value);
  });

  it('builds an escaped HTML table with header cells for spreadsheet paste', () => {
    expect(toHtmlTable(table([['<b>Name</b>', 'Age'], ['Ann & Bob', 'a\nb'], ['=1+1', '2']]))).toBe(
      '<table><thead><tr><th>&lt;b&gt;Name&lt;/b&gt;</th><th>Age</th></tr></thead><tbody><tr><td>Ann &amp; Bob</td><td>a<br>b</td></tr><tr><td>\'=1+1</td><td>2</td></tr></tbody></table>',
    );
  });
});

describe('Markdown', () => {
  it('writes a padded pipe table with the combined header', () => {
    const data = table([['Region', 'Population', 'Population'], ['Region', '2010', '2020'], ['North', '1,200', '1,350']], 2);
    expect(toMarkdown(data)).toBe(
      '| Region | Population / 2010 | Population / 2020 |\n| ------ | ----------------- | ----------------- |\n| North  | 1,200             | 1,350             |',
    );
  });

  it('adds an empty header row for tables without one', () => {
    expect(toMarkdown(table([['alpha', '1'], ['beta', '2']], 0))).toBe('|       |     |\n| ----- | --- |\n| alpha | 1   |\n| beta  | 2   |');
  });

  it('escapes pipes and Markdown syntax so cell text stays text', () => {
    expect(markdownCell('a | b')).toBe('a \\| b');
    expect(markdownCell('*not bold* and `code`')).toBe('\\*not bold\\* and \\`code\\`');
    expect(markdownCell('[link](x) <b>tag</b> 3 < 4')).toBe('\\[link\\](x) \\<b>tag\\</b> 3 < 4');
    expect(markdownCell('snake_case _emph_ C:\\dir')).toBe('snake_case \\_emph\\_ C:\\\\dir');
    expect(markdownCell('line 1\n  line 2')).toBe('line 1<br>line 2');
  });

  it('caps padding for very long cells', () => {
    const long = 'x'.repeat(100);
    const [header] = toMarkdown(table([['A'], [long]])).split('\n');
    expect(header).toBe(`| A${' '.repeat(39)} |`);
  });

  it('is empty for an empty table', () => {
    expect(toMarkdown(table([], 0))).toBe('');
  });
});

describe('JSON', () => {
  it('keys rows by header, deduplicates duplicate and empty names, keeps column order', () => {
    const data = table([['Name', '2020', 'Name', '', '2010', 'Name 2'], ['Ann', '5', 'A.', 'x', '4', 'y']]);
    expect(columnKeys(data)).toEqual(['Name', '2020', 'Name 2', 'Column 4', '2010', 'Name 2 2']);
    const json = toJson(data);
    expect(json.indexOf('"2020"')).toBeLessThan(json.indexOf('"2010"'));
    expect(JSON.parse(json)).toEqual([{ Name: 'Ann', '2020': '5', 'Name 2': 'A.', 'Column 4': 'x', '2010': '4', 'Name 2 2': 'y' }]);
  });

  it('uses "Column N" keys without a header, escapes values, and is [] without body rows', () => {
    expect(JSON.parse(toJson(table([['a "q"', 'line\nbreak']], 0)))).toEqual([{ 'Column 1': 'a "q"', 'Column 2': 'line\nbreak' }]);
    expect(toJson(table([['Only', 'Header']]))).toBe('[]');
  });
});

describe('formatTable', () => {
  const data = table([['Plan', 'Price'], ['Pro', '$12, monthly']]);

  it('produces every format, TSV with an HTML table next to it', () => {
    expect(formatTable(data, 'csv', { csvDelimiter: ',' })).toEqual({ text: 'Plan,Price\nPro,"$12, monthly"' });
    expect(formatTable(data, 'csv', { csvDelimiter: ';' })).toEqual({ text: 'Plan;Price\nPro;$12, monthly' });
    const tsv = formatTable(data, 'tsv', { csvDelimiter: ',' });
    expect(tsv.text).toBe('Plan\tPrice\nPro\t$12, monthly');
    expect(tsv.html).toContain('<th>Plan</th>');
    expect(formatTable(data, 'markdown', { csvDelimiter: ',' }).text).toBe('| Plan | Price        |\n| ---- | ------------ |\n| Pro  | $12, monthly |');
    expect(JSON.parse(formatTable(data, 'json', { csvDelimiter: ',' }).text)).toEqual([{ Plan: 'Pro', Price: '$12, monthly' }]);
  });

  it('gives an empty payload for an empty table', () => {
    expect(formatTable(table([], 0), 'tsv', { csvDelimiter: ',' })).toEqual({ text: '' });
  });
});

describe('fileName', () => {
  it('turns a title into a safe file name', () => {
    expect(fileName('Population by region', 'xlsx')).toBe('population-by-region.xlsx');
    expect(fileName('Café: "prices" / 2024?', 'csv')).toBe('cafe-prices-2024.csv');
    expect(fileName('Населення Київ', 'xlsx')).toBe('населення-київ.xlsx');
    expect(fileName('   ', 'xlsx')).toBe('table.xlsx');
    expect(fileName('a'.repeat(100), 'xlsx')).toBe(`${'a'.repeat(60)}.xlsx`);
  });
});

describe('downloaded files', () => {
  it('starts CSV and TSV files with a byte order mark (Excel reads them as UTF-8) and ends every file with a line break', () => {
    const data = table([['Name', 'City'], ['Łukasz', 'Kraków']]);
    expect(fileText(data, 'csv', { csvDelimiter: ';' })).toBe('\uFEFFName;City\nŁukasz;Kraków\n');
    expect(fileText(data, 'tsv', { csvDelimiter: ',' })).toBe('\uFEFFName\tCity\nŁukasz\tKraków\n');
    expect(fileText(data, 'markdown', { csvDelimiter: ',' }).startsWith('| Name')).toBe(true);
    expect(JSON.parse(fileText(data, 'json', { csvDelimiter: ',' }))).toEqual([{ Name: 'Łukasz', City: 'Kraków' }]);
    expect(fileText(table([]), 'csv', { csvDelimiter: ',' })).toBe('');
  });

  it('knows the extension and type of every format', () => {
    expect(EXPORT_FORMATS.map((format) => FILE_TYPES[format].extension)).toEqual(['csv', 'tsv', 'md', 'json', 'xlsx']);
    expect(FILE_TYPES.csv.mime).toBe('text/csv;charset=utf-8');
    expect(FILE_TYPES.xlsx.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(isExportFormat('xlsx')).toBe(true);
    expect(isExportFormat('pdf')).toBe(false);
  });
});
