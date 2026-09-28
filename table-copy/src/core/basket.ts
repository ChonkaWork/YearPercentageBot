import type { DecimalSeparator } from './cellValue';
import { columnKeys, uniqueKeys } from './formats';
import type { Limits } from './plan';
import type { TableData } from './table';
import type { XlsxSheet } from './xlsx';

/**
 * The basket: tables collected from one or more pages (stored locally) and exported
 * together. Merging stacks the rows and lines columns up by header name, so tables with
 * the same columns in a different order, or with a few extra columns, still merge.
 */

export interface BasketItem {
  id: string;
  /** Table caption or nearest heading; may be empty. */
  title: string;
  pageTitle: string;
  url: string;
  addedAt: number;
  /** One key per column (combined, unique header labels, or "Column N"). */
  columns: string[];
  /** Body rows, each as long as `columns`. */
  rows: string[][];
  /** Decimal separator of the page, for .xlsx numbers. */
  decimal: DecimalSeparator;
}

export interface BasketSource {
  title: string;
  pageTitle: string;
  url: string;
  decimal: DecimalSeparator;
}

export type AddResult =
  | { ok: true; items: BasketItem[]; item: BasketItem }
  | { ok: false; reason: 'not-allowed' | 'empty' | 'full' | 'too-big' | 'duplicate' };

export const SOURCE_COLUMN = 'Source';
export const SOURCE_URL_COLUMN = 'Source URL';

export function basketItemFrom(data: TableData, source: BasketSource, id: string, addedAt: number): BasketItem {
  const columns = columnKeys(data);
  const rows = data.rows.slice(data.headerRows).map((row) => columns.map((_, index) => row[index] ?? ''));
  return { id, title: source.title, pageTitle: source.pageTitle, url: source.url, addedAt, columns, rows, decimal: source.decimal };
}

export function cellCount(items: readonly BasketItem[]): number {
  return items.reduce((sum, item) => sum + item.rows.length * item.columns.length, 0);
}

function signature(item: BasketItem): string {
  return JSON.stringify([item.url, item.columns, item.rows.length, item.rows[0] ?? [], item.rows[item.rows.length - 1] ?? []]);
}

export function addToBasket(items: readonly BasketItem[], item: BasketItem, limits: Limits): AddResult {
  if (limits.basketTables <= 0) return { ok: false, reason: 'not-allowed' };
  if (item.rows.length === 0 || item.columns.length === 0) return { ok: false, reason: 'empty' };
  if (items.some((existing) => signature(existing) === signature(item))) return { ok: false, reason: 'duplicate' };
  if (items.length >= limits.basketTables) return { ok: false, reason: 'full' };
  if (cellCount(items) + item.rows.length * item.columns.length > limits.basketCells) return { ok: false, reason: 'too-big' };
  return { ok: true, items: [...items, item], item };
}

export function removeFromBasket(items: readonly BasketItem[], id: string): BasketItem[] {
  return items.filter((item) => item.id !== id);
}

/** What the basket calls a table: its title, the page title, the site, or "Table N". */
export function itemLabel(item: BasketItem, index: number): string {
  if (item.title.trim()) return item.title.trim();
  if (item.pageTitle.trim()) return item.pageTitle.trim();
  try {
    return new URL(item.url).host || `Table ${index + 1}`;
  } catch {
    return `Table ${index + 1}`;
  }
}

export function itemHost(item: BasketItem): string {
  try {
    return new URL(item.url).host;
  } catch {
    return '';
  }
}

export interface MergeOptions {
  /** Add "Source" (the table's label) and "Source URL" columns first. */
  source: boolean;
}

/**
 * All basket tables stacked into one: a single header row with every column name in
 * order of first appearance, then every table's rows. A table that lacks a column gets an
 * empty cell there.
 */
export function mergeBasket(items: readonly BasketItem[], options: MergeOptions): TableData {
  if (items.length === 0) return { rows: [], headerRows: 0, width: 0, truncated: false };
  const columns: string[] = [];
  const position = new Map<string, number>();
  for (const item of items) {
    for (const key of item.columns) {
      if (!position.has(key)) {
        position.set(key, columns.length);
        columns.push(key);
      }
    }
  }
  const sourceColumns = options.source ? uniqueSourceColumns(columns) : [];
  const header = [...sourceColumns, ...columns];
  const rows: string[][] = [header];
  items.forEach((item, index) => {
    const label = itemLabel(item, index);
    const mapping = item.columns.map((key) => position.get(key) ?? -1);
    for (const row of item.rows) {
      const out = new Array<string>(columns.length).fill('');
      mapping.forEach((target, column) => {
        if (target >= 0) out[target] = row[column] ?? '';
      });
      rows.push(options.source ? [label, item.url, ...out] : out);
    }
  });
  return { rows, headerRows: 1, width: header.length, truncated: false };
}

/** "Source" and "Source URL", renamed if a table already has columns called that. */
function uniqueSourceColumns(columns: readonly string[]): string[] {
  const taken = new Set(columns);
  const pick = (name: string) => {
    let key = name;
    for (let n = 2; taken.has(key); n++) key = `${name} (${n})`;
    taken.add(key);
    return key;
  };
  return [pick(SOURCE_COLUMN), pick(SOURCE_URL_COLUMN)];
}

/** The decimal separator shared by every table, or null when they disagree. */
export function commonDecimal(items: readonly BasketItem[]): DecimalSeparator | null {
  const first = items[0]?.decimal ?? '.';
  return items.every((item) => item.decimal === first) ? first : null;
}

export interface SheetsOptions extends MergeOptions {
  layout: 'stack' | 'sheets';
}

/** Worksheets for the basket: one stacked sheet, or one sheet per table (named after it). */
export function basketSheets(items: readonly BasketItem[], options: SheetsOptions): XlsxSheet[] {
  if (options.layout === 'stack') {
    const merged = mergeBasket(items, options);
    return [{ name: 'Merged tables', rows: merged.rows, headerRows: merged.headerRows, decimal: commonDecimal(items) }];
  }
  return items.map((item, index) => {
    const header = options.source ? [...uniqueSourceColumns(item.columns), ...item.columns] : item.columns;
    const label = itemLabel(item, index);
    const rows = item.rows.map((row) => (options.source ? [label, item.url, ...row] : row));
    return { name: label, rows: [uniqueKeys(header), ...rows], headerRows: 1, decimal: item.decimal };
  });
}

// --- Storage ----------------------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Accepts anything read from storage; drops malformed items, never throws. */
export function sanitizeBasket(raw: unknown): BasketItem[] {
  if (!Array.isArray(raw)) return [];
  const items: BasketItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== 'string' || !isStringArray(value.columns) || !Array.isArray(value.rows)) continue;
    const columns = value.columns;
    if (!value.rows.every(isStringArray)) continue;
    const rows = (value.rows as string[][]).map((row) => columns.map((_, index) => row[index] ?? ''));
    items.push({
      id: value.id,
      title: typeof value.title === 'string' ? value.title : '',
      pageTitle: typeof value.pageTitle === 'string' ? value.pageTitle : '',
      url: typeof value.url === 'string' ? value.url : '',
      addedAt: typeof value.addedAt === 'number' ? value.addedAt : 0,
      columns,
      rows,
      decimal: value.decimal === ',' ? ',' : '.',
    });
  }
  return items;
}
