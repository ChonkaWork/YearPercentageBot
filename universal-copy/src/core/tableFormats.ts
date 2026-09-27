import { combineHeaderRows, type TableData } from './table';
import { escapeHtml } from './text';

export type CsvDelimiter = ',' | ';';

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

/**
 * JSON keys, one per column: the combined header label, "Column N" when empty, and a
 * " 2", " 3"... suffix for duplicates. Without header rows every column is "Column N".
 */
export function columnKeys(data: TableData): string[] {
  const labels = data.headerRows > 0 ? combineHeaderRows(data) : new Array<string>(data.width).fill('');
  const used = new Set<string>();
  const keys: string[] = [];
  labels.forEach((label, index) => {
    const base = label || `Column ${index + 1}`;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base} ${n}`;
    used.add(key);
    keys.push(key);
  });
  return keys;
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
