import { isElement, textContent, type SnapElement, type SnapNode } from './snapshot';

/**
 * The HTML table model, on snapshot data: row groups, colspan/rowspan expansion into a
 * rectangular grid, and header-row detection. Formatting lives in tableFormats.ts.
 */

export interface Slot<T> {
  cell: T;
  /** True for the top-left slot of a spanning cell (where the cell "is" in the source). */
  origin: boolean;
}

export interface GridLayout<T> {
  /** Rectangular: every row has `width` entries; null where the source has no cell. */
  rows: (Slot<T> | null)[][];
  width: number;
  /** Hit a size limit; the grid holds the first part of the table. */
  truncated: boolean;
}

export interface CellSpan {
  colSpan: number;
  rowSpan: number;
}

export const MAX_COLUMNS = 1000;
export const MAX_ROWS = 100_000;
export const MAX_CELLS = 2_000_000;

/**
 * Lays out rows of cells, grouped by row group (thead, each tbody, tfoot), following the
 * HTML table processing model: a cell takes the first free column of its row, spans are
 * clipped at the end of their row group, rowspan=0 spans to the end of the group, and
 * overlapping cells (a table error) never overwrite each other.
 */
export function layoutGrid<T>(groups: readonly (readonly (readonly T[])[])[], span: (cell: T) => CellSpan): GridLayout<T> {
  const rows: (Slot<T> | undefined)[][] = [];
  let truncated = false;
  let cells = 0;

  outer: for (const group of groups) {
    const base = rows.length;
    for (let r = 0; r < group.length; r++) {
      const y = base + r;
      if (y >= MAX_ROWS) {
        truncated = true;
        break outer;
      }
      const row = (rows[y] ??= []);
      let x = 0;
      for (const cell of group[r] ?? []) {
        while (row[x] !== undefined) x++;
        if (x >= MAX_COLUMNS) {
          truncated = true;
          break;
        }
        const { colSpan, rowSpan } = span(cell);
        const cols = clampInt(colSpan, 1, 1000, 1);
        const remaining = group.length - r;
        const rawRows = Number.isFinite(rowSpan) ? Math.floor(rowSpan) : 1;
        const spanRows = rawRows === 0 ? remaining : Math.min(clampInt(rawRows, 1, 65534, 1), remaining);
        for (let dy = 0; dy < spanRows; dy++) {
          const target = (rows[y + dy] ??= []);
          for (let dx = 0; dx < cols && x + dx < MAX_COLUMNS; dx++) {
            if (target[x + dx] === undefined) {
              target[x + dx] = { cell, origin: dx === 0 && dy === 0 };
              cells++;
            }
          }
        }
        if (cells > MAX_CELLS) {
          truncated = true;
          break outer;
        }
        x += cols;
      }
    }
  }

  let width = 0;
  for (const row of rows) width = Math.max(width, row?.length ?? 0);
  const grid: (Slot<T> | null)[][] = [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] ?? [];
    const filled: (Slot<T> | null)[] = [];
    for (let x = 0; x < width; x++) filled.push(row[x] ?? null);
    grid.push(filled);
  }
  return { rows: grid, width, truncated };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

// --- Snapshot tables ----------------------------------------------------------------------

export interface TableModel extends GridLayout<SnapElement> {
  /** Leading rows that are header rows. */
  headerRows: number;
  /** Per grid row, its aria-rowindex on the page (virtualized grids); absent when no row has one. */
  rowIndexes?: (number | null)[];
}

const CELL_TAGS = new Set(['td', 'th']);

/** Row groups (their <tr> elements) in the order of HTMLTableElement.rows: thead, bodies, tfoot. */
export function tableRowGroups(table: SnapElement): SnapElement[][] {
  const head: SnapElement[] = [];
  const foot: SnapElement[] = [];
  const bodies: SnapElement[][] = [];
  let implicit: SnapElement[] | null = null;
  const rowsOf = (group: SnapElement) => group.c.filter((child): child is SnapElement => isElement(child) && child.tag === 'tr');

  for (const child of table.c) {
    if (!isElement(child)) continue;
    switch (child.tag) {
      case 'thead':
        head.push(...rowsOf(child));
        implicit = null;
        break;
      case 'tfoot':
        foot.push(...rowsOf(child));
        implicit = null;
        break;
      case 'tbody':
        bodies.push(rowsOf(child));
        implicit = null;
        break;
      case 'tr':
        if (!implicit) {
          implicit = [];
          bodies.push(implicit);
        }
        implicit.push(child);
        break;
      default:
        break;
    }
  }
  return [head, ...bodies, foot].filter((group) => group.length > 0);
}

function cellsOf(row: SnapElement): SnapElement[] {
  return row.c.filter((child): child is SnapElement => isElement(child) && CELL_TAGS.has(child.tag));
}

/** Cells of each row, per row group. */
export function tableGroups(table: SnapElement): SnapElement[][][] {
  return tableRowGroups(table).map((group) => group.map(cellsOf));
}

export function buildTableModel(table: SnapElement): TableModel {
  const rowGroups = tableRowGroups(table);
  const groups = rowGroups.map((group) => group.map(cellsOf));
  const layout = layoutGrid(groups, (cell) => ({ colSpan: cell.a?.colspan ?? 1, rowSpan: cell.a?.rowspan ?? 1 }));
  const theadRows = table.c.some((child) => isElement(child) && child.tag === 'thead') ? (groups[0]?.length ?? 0) : 0;
  const model: TableModel = { ...layout, headerRows: Math.min(detectHeaderRows(layout.rows, theadRows), layout.rows.length) };
  // Grid rows match source rows one to one (spans are clipped to their row group).
  const rows = rowGroups.flat();
  if (rows.some((row) => row.a?.rowindex !== undefined)) {
    model.rowIndexes = layout.rows.map((_, index) => rows[index]?.a?.rowindex ?? null);
  }
  return model;
}

function detectHeaderRows(rows: (Slot<SnapElement> | null)[][], theadRows: number): number {
  if (theadRows > 0) return theadRows;

  // Leading rows made only of <th> cells.
  let count = 0;
  for (const row of rows) {
    const cells = row.filter((slot): slot is Slot<SnapElement> => slot !== null);
    if (cells.length === 0 || !cells.every((slot) => slot.cell.tag === 'th')) break;
    count++;
  }
  if (count > 0) return count === rows.length && rows.length > 1 ? 1 : count;

  // A first row where every non-empty cell is entirely bold: a header without <th>.
  const first = rows[0];
  if (rows.length > 1 && first) {
    const cells = first.filter((slot): slot is Slot<SnapElement> => slot?.origin === true).map((slot) => slot.cell);
    const nonEmpty = cells.filter((cell) => textContent(cell).trim() !== '');
    if (nonEmpty.length > 0 && nonEmpty.every(isEntirelyBold)) return 1;
  }
  return 0;
}

function isEntirelyBold(cell: SnapElement): boolean {
  let outside = '';
  const walk = (node: SnapNode, bold: boolean) => {
    if (!isElement(node)) {
      if (!bold) outside += node.v;
      return;
    }
    const nowBold = bold || node.tag === 'b' || node.tag === 'strong';
    for (const child of node.c) walk(child, nowBold);
  };
  for (const child of cell.c) walk(child, false);
  return outside.trim() === '';
}

// --- Cell text grid -----------------------------------------------------------------------

export interface TableData {
  /** Cell values, rectangular. Header rows first. */
  rows: string[][];
  headerRows: number;
  width: number;
  truncated: boolean;
  /**
   * Per cell, the URL when the cell's whole content is one http(s) link, otherwise ''.
   * Same shape as `rows`. Absent when no cell is a link (see links.ts).
   */
  links?: string[][];
  /** Per row, its aria-rowindex on the page, or null. Absent when no row has one. */
  rowIndexes?: (number | null)[];
}

export interface ExtractOptions {
  /** URL of a cell that is a single link, '' otherwise. Without it, no `links` are returned. */
  link?: (cell: SnapElement) => string;
  /**
   * 'trailing' (default) drops trailing empty columns, 'all' every column without content
   * (ARIA grids: checkbox and filler columns), 'none' keeps the full width (row recording,
   * where every capture must keep the same columns).
   */
  dropEmptyColumns?: 'trailing' | 'all' | 'none';
}

/**
 * Renders every cell with `render` and returns a rectangular grid of strings. Spanning
 * cells either repeat their value in every slot they cover ('repeat', what spreadsheets
 * and data tools expect) or only fill their first slot ('first'). Rows with no content at
 * all and trailing empty columns are dropped.
 */
export function extractTableData(
  model: TableModel,
  render: (cell: SnapElement) => string,
  spans: 'repeat' | 'first' = 'repeat',
  options: ExtractOptions = {},
): TableData {
  const cached = (cache: Map<SnapElement, string>, fn: (cell: SnapElement) => string) => (slot: Slot<SnapElement> | null): string => {
    if (!slot || (spans === 'first' && !slot.origin)) return '';
    let value = cache.get(slot.cell);
    if (value === undefined) {
      value = fn(slot.cell);
      cache.set(slot.cell, value);
    }
    return value;
  };
  const valueOf = cached(new Map(), render);
  const linkOf = options.link ? cached(new Map(), options.link) : null;

  const rows: string[][] = [];
  const links: string[][] = [];
  const rowIndexes: (number | null)[] = [];
  let headerRows = 0;
  let anyLink = false;
  model.rows.forEach((row, index) => {
    const values = row.map(valueOf);
    // A row is empty when none of its cells has content, not just its own slots.
    const hasContent = row.some((slot) => slot !== null && valueOf({ cell: slot.cell, origin: true }).trim() !== '');
    if (!hasContent) return;
    rows.push(values);
    rowIndexes.push(model.rowIndexes?.[index] ?? null);
    if (linkOf) {
      const urls = row.map(linkOf);
      if (urls.some(Boolean)) anyLink = true;
      links.push(urls);
    }
    if (index < model.headerRows) headerRows++;
  });

  const mode = options.dropEmptyColumns ?? 'trailing';
  const empty = (column: number) => rows.every((row) => (row[column] ?? '').trim() === '');
  let keep: number[] = [];
  if (mode === 'all') {
    for (let column = 0; column < model.width; column++) if (!empty(column)) keep.push(column);
  } else {
    let width = model.width;
    if (mode === 'trailing') while (width > 0 && empty(width - 1)) width--;
    keep = Array.from({ length: width }, (_, column) => column);
  }
  const identity = keep.every((column, position) => column === position);
  const cut = (row: string[]) => (identity ? row.slice(0, keep.length) : keep.map((column) => row[column] ?? ''));

  const data: TableData = {
    rows: rows.map(cut),
    headerRows: rows.length > 0 ? headerRows : 0,
    width: rows.length > 0 ? keep.length : 0,
    truncated: model.truncated,
  };
  if (anyLink && data.width > 0) {
    const kept = links.map(cut);
    if (kept.some((row) => row.some(Boolean))) data.links = kept;
  }
  if (rows.length > 0 && rowIndexes.some((value) => value !== null)) data.rowIndexes = rowIndexes;
  return data;
}

/**
 * One header label per column. Several header rows (grouped headers) are combined per
 * column: "Population / 2010". Values repeated by colspan/rowspan appear once.
 */
export function combineHeaderRows(data: TableData, separator = ' / '): string[] {
  const labels: string[] = [];
  for (let column = 0; column < data.width; column++) {
    const parts: string[] = [];
    for (let row = 0; row < data.headerRows; row++) {
      const value = (data.rows[row]?.[column] ?? '').replace(/\s*\n\s*/g, ' ').trim();
      if (value && parts[parts.length - 1] !== value) parts.push(value);
    }
    labels.push(parts.join(separator));
  }
  return labels;
}
