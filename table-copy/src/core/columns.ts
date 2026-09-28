import { combineHeaderRows, type TableData } from './table';

/**
 * Column picker: which columns to export and in what order. A selection is a list of
 * source column indexes; its order is the output order. Pure, so the popup only renders.
 */

export interface ColumnState {
  /** Every source column, in the user's order. */
  order: number[];
  /** Source column indexes that are switched on. */
  enabled: Set<number>;
}

export function allColumns(width: number): number[] {
  return Array.from({ length: Math.max(0, width) }, (_, index) => index);
}

export function initialColumns(width: number): ColumnState {
  const order = allColumns(width);
  return { order, enabled: new Set(order) };
}

/** Enabled columns in the chosen order: the selection passed to pickColumns(). */
export function selectedColumns(state: ColumnState): number[] {
  return state.order.filter((index) => state.enabled.has(index));
}

/** True when the selection is every column in the original order (nothing to apply). */
export function isIdentity(selection: readonly number[], width: number): boolean {
  return selection.length === width && selection.every((column, index) => column === index);
}

/**
 * The table with only the selected columns, in the selection's order. Header rows stay
 * header rows. Unknown or repeated indexes are ignored.
 */
export function pickColumns(data: TableData, selection: readonly number[]): TableData {
  const seen = new Set<number>();
  const columns = selection.filter((column) => {
    if (!Number.isInteger(column) || column < 0 || column >= data.width || seen.has(column)) return false;
    seen.add(column);
    return true;
  });
  if (isIdentity(columns, data.width)) return data;
  const pick = (row: readonly string[]) => columns.map((column) => row[column] ?? '');
  // Rows that only had content in dropped columns are dropped too (header rows are kept).
  const kept: number[] = [];
  let headerRows = 0;
  data.rows.forEach((row, index) => {
    const header = index < data.headerRows;
    if (!header && columns.every((column) => (row[column] ?? '').trim() === '')) return;
    kept.push(index);
    if (header) headerRows++;
  });
  if (columns.length === 0) return { rows: [], headerRows: 0, width: 0, truncated: data.truncated };
  const picked: TableData = { rows: kept.map((index) => pick(data.rows[index] ?? [])), headerRows, width: columns.length, truncated: data.truncated };
  const links = data.links;
  if (links) {
    const linkRows = kept.map((index) => pick(links[index] ?? []));
    if (linkRows.some((row) => row.some(Boolean))) picked.links = linkRows;
  }
  if (data.rowIndexes) picked.rowIndexes = kept.map((index) => data.rowIndexes?.[index] ?? null);
  return picked;
}

/** Moves the column at `position` in the order one step up (-1) or down (+1). */
export function moveColumn(order: readonly number[], position: number, step: -1 | 1): number[] {
  const target = position + step;
  const next = [...order];
  if (position < 0 || position >= next.length || target < 0 || target >= next.length) return next;
  const [item] = next.splice(position, 1);
  next.splice(target, 0, item as number);
  return next;
}

/**
 * Moves `column` one step up or down among the `visible` columns (the picker's filter):
 * it swaps places with the nearest visible neighbour, hidden columns stay where they are.
 */
export function moveVisibleColumn(order: readonly number[], column: number, step: -1 | 1, visible: ReadonlySet<number>): number[] {
  const position = order.indexOf(column);
  if (position < 0) return [...order];
  let target = position + step;
  while (target >= 0 && target < order.length && !visible.has(order[target] as number)) target += step;
  if (target < 0 || target >= order.length) return [...order];
  const next = [...order];
  next[position] = order[target] as number;
  next[target] = column;
  return next;
}

/**
 * Drag and drop: moves `column` so it lands just before `before` (or last when `before`
 * is null). Unknown columns leave the order unchanged.
 */
export function moveColumnTo(order: readonly number[], column: number, before: number | null): number[] {
  if (column === before || !order.includes(column) || (before !== null && !order.includes(before))) return [...order];
  const next = order.filter((entry) => entry !== column);
  const at = before === null ? next.length : next.indexOf(before);
  next.splice(at, 0, column);
  return next;
}

/** Columns whose label or sample values contain the filter text (case-insensitive). */
export function filterColumns(labels: readonly string[], samples: readonly string[], query: string): Set<number> {
  const needle = query.trim().toLocaleLowerCase();
  const visible = new Set<number>();
  labels.forEach((label, column) => {
    if (!needle || label.toLocaleLowerCase().includes(needle) || (samples[column] ?? '').toLocaleLowerCase().includes(needle)) visible.add(column);
  });
  return visible;
}

/** Labels shown in the picker: the combined header, or "Column N" for tables without one. */
export function columnLabels(data: TableData): string[] {
  const labels = data.headerRows > 0 ? combineHeaderRows(data) : new Array<string>(data.width).fill('');
  return labels.map((label, index) => label || `Column ${index + 1}`);
}

/** A short sample of a column's values, for the picker. */
export function columnSample(data: TableData, column: number, max = 3): string {
  const values: string[] = [];
  for (const row of data.rows.slice(data.headerRows)) {
    const value = (row[column] ?? '').replace(/\s+/g, ' ').trim();
    if (value) values.push(value);
    if (values.length >= max) break;
  }
  return values.join(', ');
}
