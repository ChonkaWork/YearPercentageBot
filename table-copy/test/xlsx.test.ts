// @vitest-environment jsdom
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildXlsx, cleanXmlText, columnName, uniqueSheetNames, type XlsxSheet } from '../src/core/xlsx';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) throw new Error(`Invalid XML: ${error.textContent}\n${text.slice(0, 300)}`);
  return doc;
}

interface Cell {
  type: 'string' | 'number';
  value: string | number;
  style: number;
}

/** A tiny .xlsx reader: enough to check what Excel would see. */
function readWorkbook(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const xml = (path: string) => {
    const file = files[path];
    if (!file) throw new Error(`Missing part ${path}`);
    return parseXml(strFromU8(file));
  };
  const strings = [...xml('xl/sharedStrings.xml').getElementsByTagNameNS(MAIN, 'si')].map((si) => si.textContent ?? '');
  const rels = new Map([...xml('xl/_rels/workbook.xml.rels').getElementsByTagName('Relationship')].map((rel) => [rel.getAttribute('Id'), rel.getAttribute('Target')]));
  const sheets = [...xml('xl/workbook.xml').getElementsByTagNameNS(MAIN, 'sheet')].map((sheet) => {
    const target = rels.get(sheet.getAttributeNS(REL, 'id'));
    const doc = xml(`xl/${target}`);
    const cells = new Map<string, Cell>();
    for (const c of doc.getElementsByTagNameNS(MAIN, 'c')) {
      const v = c.getElementsByTagNameNS(MAIN, 'v')[0]?.textContent ?? '';
      const style = Number(c.getAttribute('s') ?? 0);
      if (c.getAttribute('t') === 's') cells.set(c.getAttribute('r') ?? '', { type: 'string', value: strings[Number(v)] ?? '<missing>', style });
      else if (c.getAttribute('t') === null) cells.set(c.getAttribute('r') ?? '', { type: 'number', value: Number(v), style });
      else throw new Error(`Unexpected cell type ${c.getAttribute('t')}`);
    }
    return { name: sheet.getAttribute('name'), doc, cells };
  });
  return { files, xml, sheets };
}

const pricing: XlsxSheet = {
  name: 'Pricing',
  rows: [
    ['Plan', 'Price', 'Seats', 'Share', 'Code'],
    ['Free', '$0', '1', '12.5%', '007'],
    ['Team', '$30/mo', '1,250', '50%', '=HYPERLINK("http://evil","x")'],
  ],
  headerRows: 1,
};

describe('buildXlsx', () => {
  it('writes every required package part as well-formed XML with the right content types', () => {
    const { files, xml } = readWorkbook(buildXlsx([pricing]));
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const types = xml('[Content_Types].xml');
    const overrides = new Map([...types.getElementsByTagName('Override')].map((node) => [node.getAttribute('PartName'), node.getAttribute('ContentType')]));
    expect(overrides.get('/xl/workbook.xml')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
    expect(overrides.get('/xl/worksheets/sheet1.xml')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
    expect(overrides.get('/xl/sharedStrings.xml')).toContain('sharedStrings+xml');
    expect(overrides.get('/xl/styles.xml')).toContain('styles+xml');
    const root = xml('_rels/.rels').getElementsByTagName('Relationship')[0];
    expect(root?.getAttribute('Target')).toBe('xl/workbook.xml');
    // Every part is readable XML (parseXml throws otherwise).
    for (const path of Object.keys(files)) expect(() => xml(path)).not.toThrow();
  });

  it('stores numbers as numbers where safe and everything else as text, never as formulas', () => {
    const { sheets, files } = readWorkbook(buildXlsx([pricing]));
    const { cells } = sheets[0]!;
    expect(cells.get('A1')).toEqual({ type: 'string', value: 'Plan', style: 1 });
    expect(cells.get('B2')).toEqual({ type: 'string', value: '$0', style: 0 });
    expect(cells.get('C2')).toEqual({ type: 'number', value: 1, style: 0 });
    expect(cells.get('C3')).toEqual({ type: 'number', value: 1250, style: 6 });
    expect(cells.get('D2')).toEqual({ type: 'number', value: 0.125, style: 4 });
    expect(cells.get('D3')).toEqual({ type: 'number', value: 0.5, style: 3 });
    expect(cells.get('E2')).toEqual({ type: 'string', value: '007', style: 0 });
    expect(cells.get('E3')).toEqual({ type: 'string', value: '=HYPERLINK("http://evil","x")', style: 0 });
    expect(strFromU8(files['xl/worksheets/sheet1.xml']!)).not.toContain('<f>');
  });

  it('can keep every cell as text', () => {
    const { sheets } = readWorkbook(buildXlsx([pricing], { numbers: false }));
    expect(sheets[0]!.cells.get('C3')).toEqual({ type: 'string', value: '1,250', style: 0 });
  });

  it('reads numbers with the decimal separator of the page', () => {
    const sheet: XlsxSheet = { name: 'DE', rows: [['Wert'], ['1.234,5'], ['2,5']], headerRows: 1 };
    const { sheets } = readWorkbook(buildXlsx([sheet], { decimal: ',' }));
    expect(sheets[0]!.cells.get('A2')?.value).toBe(1234.5);
    expect(sheets[0]!.cells.get('A3')?.value).toBe(2.5);
    const text = readWorkbook(buildXlsx([{ ...sheet, decimal: null }], { decimal: ',' }));
    expect(text.sheets[0]!.cells.get('A2')).toMatchObject({ type: 'string', value: '1.234,5' });
  });

  it('freezes and bolds the header rows, sizes columns, wraps multi-line cells', () => {
    const sheet: XlsxSheet = { name: 'S', rows: [['Region', 'Population'], ['Region', '2010'], ['North', 'line 1\nline 2']], headerRows: 2 };
    const { sheets, xml } = readWorkbook(buildXlsx([sheet]));
    const { doc, cells } = sheets[0]!;
    const pane = doc.getElementsByTagNameNS(MAIN, 'pane')[0];
    expect(pane?.getAttribute('ySplit')).toBe('2');
    expect(pane?.getAttribute('state')).toBe('frozen');
    expect(pane?.getAttribute('topLeftCell')).toBe('A3');
    expect(cells.get('B2')).toMatchObject({ type: 'string', value: '2010', style: 1 });
    expect(cells.get('B3')).toMatchObject({ value: 'line 1\nline 2', style: 2 });
    expect(doc.getElementsByTagNameNS(MAIN, 'dimension')[0]?.getAttribute('ref')).toBe('A1:B3');
    const widths = [...doc.getElementsByTagNameNS(MAIN, 'col')].map((col) => Number(col.getAttribute('width')));
    expect(widths).toHaveLength(2);
    expect(widths.every((width) => width >= 8 && width <= 60)).toBe(true);
    const xfs = xml('xl/styles.xml').getElementsByTagNameNS(MAIN, 'cellXfs')[0]!;
    expect(xfs.getAttribute('count')).toBe(String(xfs.getElementsByTagNameNS(MAIN, 'xf').length));
    expect(xfs.getElementsByTagNameNS(MAIN, 'xf')[1]?.getAttribute('fontId')).toBe('1');
  });

  it('escapes XML, keeps spaces and drops characters XML cannot hold', () => {
    const sheet: XlsxSheet = { name: 'Esc', rows: [['<b>&"x"</b>', ' padded ', 'bell\u0007', 'emoji 😀']], headerRows: 0 };
    const { sheets } = readWorkbook(buildXlsx([sheet]));
    const { cells } = sheets[0]!;
    expect(cells.get('A1')?.value).toBe('<b>&"x"</b>');
    expect(cells.get('B1')?.value).toBe(' padded ');
    expect(cells.get('C1')?.value).toBe('bell');
    expect(cells.get('D1')?.value).toBe('emoji 😀');
  });

  it('writes several sheets with safe, unique names and shares repeated strings', () => {
    const sheets: XlsxSheet[] = [
      { name: 'Q1: sales/returns [draft]', rows: [['A'], ['x']], headerRows: 1 },
      { name: 'q1  sales returns  draft', rows: [['A'], ['x']], headerRows: 1 },
      { name: '', rows: [['B']], headerRows: 0 },
    ];
    const book = readWorkbook(buildXlsx(sheets));
    expect(book.sheets.map((sheet) => sheet.name)).toEqual(['Q1 sales returns draft', 'q1 sales returns draft (2)', 'Table 3']);
    expect(book.sheets[1]!.cells.get('A2')?.value).toBe('x');
    const sst = book.xml('xl/sharedStrings.xml').documentElement;
    expect(sst.getAttribute('count')).toBe('5');
    expect(sst.getAttribute('uniqueCount')).toBe('3');
  });

  it('writes an empty sheet for an empty table and a default sheet for no tables', () => {
    const book = readWorkbook(buildXlsx([{ name: 'Empty', rows: [], headerRows: 0 }]));
    expect(book.sheets[0]!.cells.size).toBe(0);
    expect(readWorkbook(buildXlsx([])).sheets.map((sheet) => sheet.name)).toEqual(['Sheet1']);
  });

  it('truncates cells beyond Excel\'s 32,767-character limit', () => {
    const { sheets } = readWorkbook(buildXlsx([{ name: 'Long', rows: [['x'.repeat(40_000)]], headerRows: 0 }]));
    expect(String(sheets[0]!.cells.get('A1')?.value).length).toBe(32_767);
  });

  it('starts with the zip signature and is deterministic for a fixed date', () => {
    const modified = new Date('2026-01-02T03:04:05Z');
    const first = buildXlsx([pricing], { modified });
    expect([...first.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(buildXlsx([pricing], { modified })).toEqual(first);
  });
});

describe('helpers', () => {
  it('names columns like Excel', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD']);
  });

  it('sanitizes sheet names', () => {
    expect(uniqueSheetNames(["'quoted'", 'History', 'x'.repeat(40), 'x'.repeat(40), 'a*b?c'])).toEqual([
      'quoted',
      'Table 2',
      'x'.repeat(31),
      `${'x'.repeat(27)} (2)`,
      'a b c',
    ]);
  });

  it('cleans text for XML', () => {
    expect(cleanXmlText('a\r\nb\rc\u0000d\uFFFEe')).toBe('a\nb\ncde');
    expect(cleanXmlText('\uD800x')).toBe('x');
    expect(cleanXmlText('😀')).toBe('😀');
  });
});
