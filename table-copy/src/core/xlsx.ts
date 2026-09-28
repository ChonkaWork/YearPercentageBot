import { strToU8, zipSync, type Zippable } from 'fflate';
import { parseNumber, type DecimalSeparator, type NumberValue } from './cellValue';

/**
 * A minimal, valid Office Open XML workbook (.xlsx): a zip of SpreadsheetML parts,
 * written by hand. Only what a table needs: several sheets, shared strings, a bold and
 * frozen header, percent and thousands formats, wrapped multi-line cells, column widths.
 *
 * Cell text is always written as a string (never as a formula), so a page can't smuggle
 * `=HYPERLINK(...)` into the file. Numbers become numbers only when parseNumber() says
 * it's safe.
 */

export interface XlsxSheet {
  name: string;
  /** Rectangular grid of cell texts, header rows first. */
  rows: string[][];
  headerRows: number;
  /** Decimal separator of this sheet's data (overrides the option); null keeps every cell as text. */
  decimal?: DecimalSeparator | null;
}

export interface XlsxOptions {
  /** Turn number-like cells into numbers (default true). */
  numbers?: boolean;
  /** Decimal separator of the page the data came from. */
  decimal?: DecimalSeparator;
  /** Zip timestamp (tests pass a fixed one). */
  modified?: Date;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel's own limits. */
export const MAX_CELL_CHARS = 32_767;
export const MAX_SHEET_ROWS = 1_048_576;
export const MAX_SHEET_COLUMNS = 16_384;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Style indexes in styles.xml (cellXfs). */
const STYLE = {
  normal: 0,
  header: 1,
  wrap: 2,
  percent0: 3,
  percent1: 4,
  percent2: 5,
  grouped0: 6,
  grouped2: 7,
} as const;

export function buildXlsx(sheets: readonly XlsxSheet[], options: XlsxOptions = {}): Uint8Array {
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [], headerRows: 0 }];
  const names = uniqueSheetNames(list.map((sheet) => sheet.name));
  const strings = new SharedStrings();
  const files: Zippable = {};
  list.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet, strings, options));
  });
  files['[Content_Types].xml'] = strToU8(contentTypes(list.length));
  files['_rels/.rels'] = strToU8(rootRels());
  files['docProps/app.xml'] = strToU8(appXml());
  files['xl/workbook.xml'] = strToU8(workbookXml(names));
  files['xl/_rels/workbook.xml.rels'] = strToU8(workbookRels(list.length));
  files['xl/styles.xml'] = strToU8(STYLES_XML);
  files['xl/sharedStrings.xml'] = strToU8(strings.xml());
  const mtime = options.modified ?? new Date();
  return zipSync(files, { level: 6, mtime });
}

// --- Worksheet --------------------------------------------------------------------------

function sheetXml(sheet: XlsxSheet, strings: SharedStrings, options: XlsxOptions): string {
  const decimal = sheet.decimal === undefined ? (options.decimal ?? '.') : sheet.decimal;
  const numbers = options.numbers !== false && decimal !== null;
  const rows = sheet.rows.slice(0, MAX_SHEET_ROWS);
  const width = Math.min(MAX_SHEET_COLUMNS, rows.reduce((max, row) => Math.max(max, row.length), 0));
  const headerRows = Math.min(Math.max(0, sheet.headerRows), rows.length);
  const widths = new Array<number>(width).fill(0);

  const rowXml: string[] = [];
  rows.forEach((row, y) => {
    const header = y < headerRows;
    const cells: string[] = [];
    for (let x = 0; x < width; x++) {
      const raw = cleanXmlText(row[x] ?? '');
      if (!raw) continue;
      const ref = `${columnName(x)}${y + 1}`;
      const longest = raw.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
      widths[x] = Math.max(widths[x] ?? 0, longest);
      const parsed = !header && numbers && decimal ? parseNumber(raw, decimal) : null;
      if (parsed) {
        const style = numberStyle(parsed);
        cells.push(`<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${formatNumber(parsed.value)}</v></c>`);
        continue;
      }
      const text = raw.length > MAX_CELL_CHARS ? raw.slice(0, MAX_CELL_CHARS) : raw;
      const style = header ? STYLE.header : text.includes('\n') ? STYLE.wrap : STYLE.normal;
      cells.push(`<c r="${ref}" t="s"${style ? ` s="${style}"` : ''}><v>${strings.index(text)}</v></c>`);
    }
    rowXml.push(cells.length ? `<row r="${y + 1}">${cells.join('')}</row>` : `<row r="${y + 1}"/>`);
  });

  const parts = [XML_HEAD, `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`];
  if (width > 0 && rows.length > 0) parts.push(`<dimension ref="A1:${columnName(width - 1)}${rows.length}"/>`);
  if (headerRows > 0 && headerRows < rows.length) {
    const topLeft = `A${headerRows + 1}`;
    parts.push(
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRows}" topLeftCell="${topLeft}" activePane="bottomLeft" state="frozen"/>` +
        `<selection pane="bottomLeft" activeCell="${topLeft}" sqref="${topLeft}"/></sheetView></sheetViews>`,
    );
  }
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (width > 0) {
    const cols = widths.map((chars, x) => `<col min="${x + 1}" max="${x + 1}" width="${columnWidth(chars)}" customWidth="1"/>`);
    parts.push(`<cols>${cols.join('')}</cols>`);
  }
  parts.push(rowXml.length ? `<sheetData>${rowXml.join('')}</sheetData>` : '<sheetData/>');
  parts.push('</worksheet>');
  return parts.join('');
}

function numberStyle(value: NumberValue): number {
  if (value.percent) return value.decimals === 0 ? STYLE.percent0 : value.decimals === 1 ? STYLE.percent1 : STYLE.percent2;
  if (value.grouped) return value.decimals === 0 ? STYLE.grouped0 : value.decimals === 2 ? STYLE.grouped2 : STYLE.normal;
  return STYLE.normal;
}

/** Shortest round-tripping form; JavaScript's exponent notation is valid xsd:double. */
function formatNumber(value: number): string {
  return String(value);
}

/** Character count to Excel column width: a little padding, within sensible bounds. */
function columnWidth(chars: number): number {
  return Math.min(60, Math.max(8, Math.ceil(chars * 1.1) + 2));
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// --- Strings ----------------------------------------------------------------------------

class SharedStrings {
  private readonly map = new Map<string, number>();
  private readonly list: string[] = [];
  private count = 0;

  index(value: string): number {
    this.count++;
    let index = this.map.get(value);
    if (index === undefined) {
      index = this.list.length;
      this.map.set(value, index);
      this.list.push(value);
    }
    return index;
  }

  xml(): string {
    const items = this.list.map((value) => {
      const space = /^\s|\s$|\n/.test(value) ? ' xml:space="preserve"' : '';
      return `<si><t${space}>${escapeXml(value)}</t></si>`;
    });
    return `${XML_HEAD}<sst xmlns="${NS_MAIN}" count="${this.count}" uniqueCount="${this.list.length}">${items.join('')}</sst>`;
  }
}

/** Characters XML 1.0 can't hold (control characters, lone surrogates) are dropped; CRLF -> LF. */
export function cleanXmlText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Sheet names ------------------------------------------------------------------------

/**
 * Excel sheet names: 1-31 characters, none of []:*?/\, not starting or ending with an
 * apostrophe, not "History", unique ignoring case.
 */
export function uniqueSheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, index) => {
    let base = raw
      .replace(/[[\]:*?/\\]/g, ' ')
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^'+|'+$/g, '')
      .trim();
    if (!base || base.toLowerCase() === 'history') base = `Table ${index + 1}`;
    base = base.slice(0, 31).trim();
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

// --- Package parts ----------------------------------------------------------------------

function contentTypes(sheets: number): string {
  const overrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
  ];
  for (let i = 1; i <= sheets; i++) {
    overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  return (
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `${overrides.join('')}</Types>`
  );
}

function rootRels(): string {
  return (
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL_BASE}/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_BASE}/extended-properties" Target="docProps/app.xml"/>` +
    '</Relationships>'
  );
}

function appXml(): string {
  return (
    `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
    '<Application>Table Copy</Application></Properties>'
  );
}

function workbookXml(names: readonly string[]): string {
  const sheets = names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`);
  return (
    `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<bookViews><workbookView/></bookViews>' +
    `<sheets>${sheets.join('')}</sheets></workbook>`
  );
}

function workbookRels(sheets: number): string {
  const rels: string[] = [];
  for (let i = 1; i <= sheets; i++) rels.push(`<Relationship Id="rId${i}" Type="${REL_BASE}/worksheet" Target="worksheets/sheet${i}.xml"/>`);
  rels.push(`<Relationship Id="rId${sheets + 1}" Type="${REL_BASE}/styles" Target="styles.xml"/>`);
  rels.push(`<Relationship Id="rId${sheets + 2}" Type="${REL_BASE}/sharedStrings" Target="sharedStrings.xml"/>`);
  return `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${rels.join('')}</Relationships>`;
}

/** cellXfs order must match STYLE. numFmt 9 = 0%, 10 = 0.00%, 3 = #,##0, 4 = #,##0.00 (built in). */
const STYLES_XML =
  `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="8">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';
