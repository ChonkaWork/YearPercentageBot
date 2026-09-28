/**
 * ARIA grids: tables built from `role="grid" | "table" | "treegrid"` with `role="row"` and
 * cell roles instead of <table> markup (AG Grid, MUI DataGrid, most dashboards). The page
 * reader collects rows and cells from the live DOM; this module decides where each cell
 * goes, so the result can be laid out like any HTML table.
 *
 * - Rows with the same aria-rowindex are one row (AG Grid splits a row across its pinned
 *   and scrolling containers). Rows are ordered by aria-rowindex: virtualized grids append
 *   rows to the DOM in whatever order they were rendered. A row without an index stays
 *   right after the row that precedes it in the DOM.
 * - Cells go to the column their aria-colindex names (1-based); gaps are empty cells.
 *   Cells without an index take the next free column after the previous cell.
 * - Leading rows made only of column headers are the header.
 */

export interface GridCell<T> {
  value: T;
  /** role="columnheader". */
  header: boolean;
  /** aria-colindex, 1-based. */
  colIndex?: number;
  /** aria-colspan. */
  colSpan?: number;
}

export interface GridRow<T> {
  /** aria-rowindex, 1-based. */
  rowIndex?: number;
  cells: GridCell<T>[];
}

export interface ArrangedRow<T> {
  rowIndex?: number;
  /** One entry per cell in column order; null is an empty cell filling a gap. */
  cells: (GridCell<T> | null)[];
}

export interface ArrangedGrid<T> {
  rows: ArrangedRow<T>[];
  /** Leading rows made only of column headers. */
  headerRows: number;
  width: number;
}

/** The largest column a grid may address; beyond it cells are dropped (a broken aria-colindex). */
export const MAX_GRID_COLUMNS = 1000;

/** A positive integer attribute value (aria-rowindex, aria-colindex, aria-colspan), or undefined. */
export function positiveInt(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !/^\s*\d+\s*$/.test(value)) return undefined;
  const number = Number(value);
  return number >= 1 && Number.isSafeInteger(number) ? number : undefined;
}

export function arrangeGrid<T>(rows: readonly GridRow<T>[]): ArrangedGrid<T> {
  // Merge rows that share an aria-rowindex, keeping the first one's DOM position.
  const merged: GridRow<T>[] = [];
  const byIndex = new Map<number, GridRow<T>>();
  for (const row of rows) {
    if (row.rowIndex !== undefined) {
      const existing = byIndex.get(row.rowIndex);
      if (existing) {
        existing.cells.push(...row.cells);
        continue;
      }
      const copy = { rowIndex: row.rowIndex, cells: [...row.cells] };
      byIndex.set(row.rowIndex, copy);
      merged.push(copy);
    } else {
      merged.push({ cells: [...row.cells] });
    }
  }

  // Sort by aria-rowindex; unindexed rows inherit the key of the row before them.
  let lastKey = Number.NEGATIVE_INFINITY;
  const keyed = merged.map((row, position) => {
    if (row.rowIndex !== undefined) lastKey = row.rowIndex;
    return { row, key: lastKey, indexed: row.rowIndex !== undefined ? 0 : 1, position };
  });
  keyed.sort((a, b) => a.key - b.key || a.indexed - b.indexed || a.position - b.position);

  const arranged = keyed.map(({ row }) => arrangeRow(row));
  let headerRows = 0;
  for (const row of arranged) {
    const cells = row.cells.filter((cell): cell is GridCell<T> => cell !== null);
    if (cells.length === 0 || !cells.every((cell) => cell.header)) break;
    headerRows++;
  }
  let width = 0;
  for (const row of arranged) width = Math.max(width, row.cells.reduce((sum, cell) => sum + (cell?.colSpan ?? 1), 0));
  return { rows: arranged, headerRows, width };
}

function arrangeRow<T>(row: GridRow<T>): ArrangedRow<T> {
  const taken = new Set<number>();
  const placed: { start: number; cell: GridCell<T> }[] = [];
  let next = 0;
  for (const cell of row.cells) {
    const span = Math.min(Math.max(1, cell.colSpan ?? 1), MAX_GRID_COLUMNS);
    let start = cell.colIndex !== undefined ? cell.colIndex - 1 : next;
    while (!isFree(taken, start, span)) start++;
    if (start + span > MAX_GRID_COLUMNS) continue;
    for (let column = start; column < start + span; column++) taken.add(column);
    placed.push({ start, cell: span === (cell.colSpan ?? 1) ? cell : { ...cell, colSpan: span } });
    next = start + span;
  }
  placed.sort((a, b) => a.start - b.start);
  const cells: (GridCell<T> | null)[] = [];
  let column = 0;
  for (const { start, cell } of placed) {
    for (; column < start; column++) cells.push(null);
    cells.push(cell);
    column = start + (cell.colSpan ?? 1);
  }
  const arranged: ArrangedRow<T> = { cells };
  if (row.rowIndex !== undefined) arranged.rowIndex = row.rowIndex;
  return arranged;
}

function isFree(taken: Set<number>, start: number, span: number): boolean {
  for (let column = start; column < start + span; column++) if (taken.has(column)) return false;
  return true;
}
