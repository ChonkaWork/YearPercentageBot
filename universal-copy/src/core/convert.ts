import { toCleanHtml } from './html';
import { tableToMarkdown, toMarkdown } from './markdown';
import { normalizeTree } from './normalize';
import { plainCellText, toPlainText } from './plainText';
import type { Settings } from './settings';
import { isElement, type SelectionSnapshot, type SnapElement } from './snapshot';
import { buildTableModel, extractTableData } from './table';
import { toCsv, toHtmlTable, toJson, toTsv } from './tableFormats';
import { escapeHtml, normalizePlainText } from './text';

/** Single entry point from snapshots to clipboard contents. Pure: no DOM, no Chrome APIs. */

export type SelectionFormat = 'text' | 'markdown' | 'html';
export type TableFormat = 'csv' | 'tsv' | 'markdown' | 'json';

export const SELECTION_FORMATS: readonly SelectionFormat[] = ['text', 'markdown', 'html'];
export const TABLE_FORMATS: readonly TableFormat[] = ['csv', 'tsv', 'markdown', 'json'];

export function isSelectionFormat(value: unknown): value is SelectionFormat {
  return typeof value === 'string' && (SELECTION_FORMATS as readonly string[]).includes(value);
}

export function isTableFormat(value: unknown): value is TableFormat {
  return typeof value === 'string' && (TABLE_FORMATS as readonly string[]).includes(value);
}

export const SELECTION_FORMAT_LABELS: Record<SelectionFormat, string> = {
  text: 'clean text',
  markdown: 'Markdown',
  html: 'HTML',
};

export const TABLE_FORMAT_LABELS: Record<TableFormat, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  markdown: 'Markdown',
  json: 'JSON',
};

/** What goes on the clipboard. `html` is added as text/html next to text/plain. */
export interface ClipboardPayload {
  text: string;
  html?: string;
}

export function convertSelection(snapshot: SelectionSnapshot, format: SelectionFormat, settings: Settings): ClipboardPayload {
  if (snapshot.kind === 'empty') return { text: '' };
  if (snapshot.kind === 'plain') return convertPlainText(snapshot.text, format);
  const text = toPlainText(snapshot.nodes, { includeLinkUrls: settings.includeLinkUrls, pageUrl: snapshot.url });
  switch (format) {
    case 'text':
      return { text };
    case 'markdown':
      return { text: toMarkdown(snapshot.nodes, { bullet: settings.bulletMarker, emphasis: settings.emphasisMarker }) };
    case 'html': {
      const html = toCleanHtml(snapshot.nodes);
      return html ? { text, html } : { text };
    }
  }
}

/**
 * Plain text in, requested format out: selections in text fields, and pages that can't be
 * read (where only Chrome's own selection text is available). The text is not Markdown-
 * escaped: text typed in a field is often Markdown already.
 */
export function convertPlainText(value: string, format: SelectionFormat): ClipboardPayload {
  const text = normalizePlainText(value);
  if (format !== 'html' || !text) return { text };
  const html = text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return { text, html };
}

export interface TableResult {
  payload: ClipboardPayload;
  rows: number;
  columns: number;
  truncated: boolean;
}

export function convertTable(table: SnapElement, format: TableFormat, settings: Settings): TableResult {
  const [normalized] = normalizeTree([table]);
  if (!isElement(normalized)) return { payload: { text: '' }, rows: 0, columns: 0, truncated: false };
  const model = buildTableModel(normalized);
  const data = extractTableData(model, (cell) => plainCellText(cell), 'repeat');
  let payload: ClipboardPayload;
  switch (format) {
    case 'csv':
      payload = { text: toCsv(data, settings.csvDelimiter) };
      break;
    case 'tsv':
      payload = data.rows.length ? { text: toTsv(data), html: toHtmlTable(data) } : { text: '' };
      break;
    case 'markdown':
      payload = { text: tableToMarkdown(normalized, { bullet: settings.bulletMarker, emphasis: settings.emphasisMarker }) };
      break;
    case 'json':
      payload = { text: data.rows.length ? toJson(data) : '' };
      break;
  }
  return { payload, rows: data.rows.length, columns: data.width, truncated: data.truncated };
}
