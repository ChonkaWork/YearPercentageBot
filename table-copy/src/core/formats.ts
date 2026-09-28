import { expandLinks, markdownUrl, withoutLinks } from './links';
import { combineHeaderRows, type TableData } from './table';
import { escapeHtml } from './text';

/**
 * Text formats for a table: CSV, TSV (+ an HTML table for spreadsheet paste), Markdown
 * and JSON. Pure: TableData in, strings out. The .xlsx writer lives in xlsx.ts.
 */

export type CsvDelimiter = ',' | ';';
export type TableFormat = 'csv' | 'tsv' | 'markdown' | 'json';
/** Everything the format switch offers: the text formats and Excel files. */
export type ExportFormat = TableFormat | 'xlsx';

export const TABLE_FORMATS: readonly TableFormat[] = ['csv', 'tsv', 'markdown', 'json'];
export const EXPORT_FORMATS: readonly ExportFormat[] = [...TABLE_FORMATS, 'xlsx'];

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  markdown: 'Markdown',
  json: 'JSON',
  xlsx: '.xlsx',
};

/** Short labels for the format switch. */
export const FORMAT_SHORT_LABELS: Record<ExportFormat, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  markdown: 'MD',
  json: 'JSON',
  xlsx: 'XLSX',
};

export function isTableFormat(value: unknown): value is TableFormat {
  return typeof value === 'string' && (TABLE_FORMATS as readonly string[]).includes(value);
}

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** What goes on the clipboard. `html` is added as text/html next to text/plain. */
export interface ClipboardPayload {
  text: string;
  html?: string;
}

export interface FormatOptions {
  csvDelimiter: CsvDelimiter;
  /** Cells that are one link keep their URL (see links.ts). */
  keepLinks?: boolean;
}

export function formatTable(source: TableData, format: TableFormat, options: FormatOptions): ClipboardPayload {
  if (source.rows.length === 0) return { text: '' };
  const linked = options.keepLinks ? source : withoutLinks(source);
  // Markdown writes links inline; the other formats get a URL column per linked column.
  const data = format === 'markdown' ? linked : expandLinks(linked);
  switch (format) {
    case 'csv':
      return { text: toCsv(data, options.csvDelimiter) };
    case 'tsv':
      return { text: toTsv(data), html: toHtmlTable(data) };
    case 'markdown':
      return { text: toMarkdown(data) };
    case 'json':
      return { text: toJson(data) };
  }
}

// --- CSV / TSV --------------------------------------------------------------------------

/**
 * RFC 4180 CSV. Fields containing the delimiter, a quote or a line break are quoted,
 * quotes are doubled. Line breaks inside cells are kept (inside quotes). Values are
 * never altered otherwise: CSV is a data format.
 */
export function toCsv(data: TableData, delimiter: CsvDelimiter = ','): string {
  return data.rows.map((row) => row.map((value) => csvField(value, delimiter)).join(delimiter)).join('\n');
}

function csvField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || /["\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Tab-separated values the way Excel and Google Sheets put them on the clipboard: a cell
 * with a line break (or starting with a quote) is quoted with doubled quotes, tabs inside
 * cells become spaces. Cells that would be run as a formula when pasted are prefixed
 * with an apostrophe, which spreadsheets treat as "this is text".
 */
export function toTsv(data: TableData): string {
  return data.rows.map((row) => row.map(tsvField).join('\t')).join('\n');
}

function tsvField(raw: string): string {
  const value = neutralizeFormula(raw.replace(/\t/g, ' '));
  if (value.includes('\n') || value.startsWith('"')) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * A page can put `=HYPERLINK(...)`/`=IMPORTXML(...)` in a cell; pasted into a
 * spreadsheet it would run. Numbers like "-5", "+380 44 123 45 67" or "-12.5%" are left
 * alone, as is a lone "-".
 */
export function neutralizeFormula(value: string): string {
  if (/^[=@]/.test(value)) return `'${value}`;
  if (/^[+-]/.test(value) && value.length > 1 && !/^[+-]?[\d\s.,]*\d[\d\s.,]*%?$/.test(value)) return `'${value}`;
  return value;
}

/** HTML table for spreadsheet paste: header rows as <th>, line breaks as <br>, text escaped. */
export function toHtmlTable(data: TableData): string {
  const cell = (tag: 'th' | 'td', value: string) => `<${tag}>${escapeHtml(neutralizeFormula(value)).replace(/\n/g, '<br>')}</${tag}>`;
  const head = data.rows.slice(0, data.headerRows);
  const body = data.rows.slice(data.headerRows);
  const parts = ['<table>'];
  if (head.length) parts.push(`<thead>${head.map((row) => `<tr>${row.map((v) => cell('th', v)).join('')}</tr>`).join('')}</thead>`);
  parts.push(`<tbody>${body.map((row) => `<tr>${row.map((v) => cell('td', v)).join('')}</tr>`).join('')}</tbody>`);
  parts.push('</table>');
  return parts.join('');
}

// --- Markdown ---------------------------------------------------------------------------

const MAX_PAD = 40;

/**
 * GitHub-flavored pipe table. Several header rows are combined into one ("Population /
 * 2010"); a table without a header row gets an empty one (pipe tables require it).
 * Cell text is escaped so it stays text, line breaks become <br>, columns are padded
 * for readability (up to a limit).
 */
export function toMarkdown(data: TableData): string {
  if (data.width === 0) return '';
  const header = data.headerRows > 0 ? combineHeaderRows(data) : new Array<string>(data.width).fill('');
  const body = data.rows.slice(data.headerRows).map((row, index) => {
    const links = data.links?.[data.headerRows + index];
    return row.map((value, column) => {
      const url = links?.[column];
      return url ? `[${markdownCell(value) || markdownCell(url)}](${markdownUrl(url)})` : markdownCell(value);
    });
  });
  const rows = [header.map(markdownCell), ...body];
  const widths: number[] = [];
  for (let column = 0; column < data.width; column++) {
    let width = 3;
    for (const row of rows) width = Math.max(width, Math.min(MAX_PAD, (row[column] ?? '').length));
    widths.push(width);
  }
  const line = (row: string[]) => `| ${row.map((value, column) => value.padEnd(widths[column] ?? 3)).join(' | ')} |`;
  const [head = [], ...rest] = rows;
  return [line(head), `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`, ...rest.map(line)].join('\n');
}

export function markdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[|`*[\]]/g, '\\$&')
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    // snake_case stays readable; an underscore at a word edge could start emphasis.
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
    .replace(/[ \t]*\n[ \t]*/g, '<br>')
    .trim();
}

// --- JSON -------------------------------------------------------------------------------

/**
 * JSON keys, one per column: the combined header label, "Column N" when empty, and a
 * " 2", " 3"... suffix for duplicates. Without header rows every column is "Column N".
 */
export function columnKeys(data: TableData): string[] {
  const labels = data.headerRows > 0 ? combineHeaderRows(data) : new Array<string>(data.width).fill('');
  return uniqueKeys(labels);
}

export function uniqueKeys(labels: readonly string[]): string[] {
  const used = new Set<string>();
  return labels.map((label, index) => {
    const base = label.trim() || `Column ${index + 1}`;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base} ${n}`;
    used.add(key);
    return key;
  });
}

/**
 * Array of objects keyed by column, in column order. Values stay strings: turning
 * "1,234" or "05" into numbers depends on locale and intent, so it's left to the user.
 * Serialized by hand because JavaScript objects move integer-like keys ("2020") first.
 */
export function toJson(data: TableData): string {
  const keys = columnKeys(data);
  const body = data.rows.slice(data.headerRows);
  if (body.length === 0) return '[]';
  const objects = body.map((row) => {
    const fields = keys.map((key, index) => `    ${JSON.stringify(key)}: ${JSON.stringify(row[index] ?? '')}`);
    return `  {\n${fields.join(',\n')}\n  }`;
  });
  return `[\n${objects.join(',\n')}\n]`;
}

// --- Files ------------------------------------------------------------------------------

export interface FileType {
  extension: string;
  mime: string;
}

export const FILE_TYPES: Record<ExportFormat, FileType> = {
  csv: { extension: 'csv', mime: 'text/csv;charset=utf-8' },
  tsv: { extension: 'tsv', mime: 'text/tab-separated-values;charset=utf-8' },
  markdown: { extension: 'md', mime: 'text/markdown;charset=utf-8' },
  json: { extension: 'json', mime: 'application/json;charset=utf-8' },
  xlsx: { extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};

/**
 * The text of a downloaded file. CSV and TSV files start with a UTF-8 byte order mark:
 * without it Excel opens them in the system's legacy encoding and garbles non-ASCII text.
 * Files end with a line break, like any text file.
 */
export function fileText(data: TableData, format: TableFormat, options: FormatOptions): string {
  const { text } = formatTable(data, format, options);
  if (!text) return '';
  const bom = format === 'csv' || format === 'tsv' ? '\uFEFF' : '';
  return `${bom}${text}\n`;
}

// --- File names -------------------------------------------------------------------------

/** A safe download name from a table title: "Population by region" -> "population-by-region.xlsx". */
export function fileName(title: string, extension: string, fallback = 'table'): string {
  const slug = title
    // Accents are dropped from Latin letters only ("Café" -> "cafe"; "Київ" stays "київ").
    .normalize('NFKD')
    .replace(/([A-Za-z])[\u0300-\u036f]+/g, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || fallback}.${extension}`;
}
