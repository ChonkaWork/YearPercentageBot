import type { DecimalSeparator } from './cellValue';
import type { TableData } from './table';

/**
 * Record rows: collects every row of a grid that only shows part of its data at a time.
 * Virtualized grids (AG Grid, MUI DataGrid, dashboards) render ~30 rows around the scroll
 * position; paginated tables replace their rows when the user clicks the site's own Next
 * button. The page takes a capture (the rows currently in the DOM) whenever the table
 * changes or scrolls; this module merges the captures into one table:
 *
 * - The header comes from the first capture. Repeated header rows are skipped.
 * - Rows with an aria-rowindex are the same row whenever that index comes back (the
 *   latest content wins, except a "Loading…" placeholder never replaces real data), and
 *   the result is ordered by it. A page that restarts its indexes (1, 2, 3... on every
 *   page of a paginated grid) is detected and appended after the rows seen so far.
 * - Other rows are identified by their content. Identical rows within one capture are
 *   kept (the page really shows them twice); a row seen again in a later capture is the
 *   same row. New rows are placed next to the rows they appeared with, so scrolling up
 *   or down keeps the page's order; a page with no known rows goes to the end.
 *
 * Pure and synchronous: the recorder in the page calls it on every capture.
 */

export interface CaptureRow {
  /** aria-rowindex, or null. */
  index: number | null;
  cells: string[];
  /** URLs of cells that are one link (see links.ts), or null. */
  links: string[] | null;
}

export interface Capture {
  header: string[][];
  rows: CaptureRow[];
  width: number;
}

interface RecordedRow {
  index: number | null;
  cells: string[];
  links: string[] | null;
}

export interface Recording {
  header: string[][];
  width: number;
  rows: Map<string, RecordedRow>;
  /** Row keys in page order. */
  order: string[];
  /** Added to aria-rowindex values of pages that restart their numbering. */
  offset: number;
  /** Every offset used so far (going back to an earlier page reuses its offset). */
  offsets: number[];
  maxIndex: number;
  cells: number;
  /** Hit a size limit: later rows were not recorded. */
  truncated: boolean;
}

export const MAX_RECORDED_ROWS = 100_000;
export const MAX_RECORDED_CELLS = 2_000_000;

export function captureFrom(data: TableData): Capture {
  const header = data.rows.slice(0, data.headerRows).map((row) => [...row]);
  const rows = data.rows.slice(data.headerRows).map((cells, offset) => {
    const position = data.headerRows + offset;
    const links = data.links?.[position];
    return { index: data.rowIndexes?.[position] ?? null, cells, links: links?.some(Boolean) ? links : null };
  });
  return { header, rows, width: data.width };
}

export function startRecording(first: Capture): Recording {
  const recording: Recording = {
    header: first.header.map((row) => [...row]),
    width: first.width,
    rows: new Map(),
    order: [],
    offset: 0,
    offsets: [0],
    maxIndex: 0,
    cells: 0,
    truncated: false,
  };
  mergeCapture(recording, first);
  return recording;
}

export function recordedRowCount(recording: Recording): number {
  return recording.rows.size;
}

/** Adds a capture to the recording. Returns how many rows were new. */
export function mergeCapture(recording: Recording, capture: Capture): number {
  recording.width = Math.max(recording.width, capture.width);
  const headers = new Set(recording.header.map(rowText));
  const rows = capture.rows.filter((row) => row.cells.some((value) => value.trim() !== '') && !headers.has(rowText(row.cells)));

  detectRestartedIndexes(recording, rows);

  const occurrences = new Map<string, number>();
  const keys: string[] = [];
  const seen = new Set<string>();
  const fresh = new Set<string>();
  for (const row of rows) {
    let key: string;
    let index: number | null = null;
    if (row.index !== null) {
      index = row.index + recording.offset;
      key = `i${index}`;
    } else {
      const hash = rowHash(row.cells);
      const occurrence = (occurrences.get(hash) ?? 0) + 1;
      occurrences.set(hash, occurrence);
      key = `h${hash}#${occurrence}`;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const stored = recording.rows.get(key);
    if (stored) {
      const change = compareRows(stored, row);
      if (change !== 'same' && change !== 'downgrade') {
        recording.cells += row.cells.length - stored.cells.length;
        stored.cells = [...row.cells];
        stored.links = row.links ? [...row.links] : null;
      }
      keys.push(key);
      continue;
    }
    if (recording.rows.size >= MAX_RECORDED_ROWS || recording.cells + row.cells.length > MAX_RECORDED_CELLS) {
      recording.truncated = true;
      continue;
    }
    recording.rows.set(key, { index, cells: [...row.cells], links: row.links ? [...row.links] : null });
    recording.cells += row.cells.length;
    if (index !== null) recording.maxIndex = Math.max(recording.maxIndex, index);
    fresh.add(key);
    keys.push(key);
  }
  if (fresh.size > 0) placeNewRows(recording, keys, fresh);
  return fresh.size;
}

/**
 * A paginated grid that numbers every page from 1: the indexes of the new page are all
 * known, and every known one now holds a different row. Its rows go after everything
 * recorded so far, unless they are a page seen before ("Previous").
 */
function detectRestartedIndexes(recording: Recording, rows: readonly CaptureRow[]): void {
  const indexed = rows.filter((row) => row.index !== null);
  if (indexed.length === 0) return;
  const fit = (offset: number) => {
    let known = 0;
    let conflicts = 0;
    for (const row of indexed) {
      const stored = recording.rows.get(`i${(row.index ?? 0) + offset}`);
      if (!stored) continue;
      known++;
      if (compareRows(stored, row) === 'conflict') conflicts++;
    }
    return { known, conflicts };
  };
  const current = fit(recording.offset);
  if (current.known === 0 || current.conflicts < current.known) return;
  const earlier = recording.offsets.find((offset) => {
    if (offset === recording.offset) return false;
    const other = fit(offset);
    return other.known > 0 && other.conflicts === 0;
  });
  if (earlier !== undefined) {
    recording.offset = earlier;
    return;
  }
  const min = Math.min(...indexed.map((row) => row.index ?? 0));
  recording.offset = recording.maxIndex + 1 - min;
  recording.offsets.push(recording.offset);
}

type Change = 'same' | 'upgrade' | 'downgrade' | 'update' | 'conflict';

/**
 * How a row at a known index changed. A row with at most one filled cell next to a real
 * one is a placeholder ("Loading…"): it may be replaced but never replaces. A row whose
 * first value (its identifier) stayed the same was updated in place (live data).
 */
function compareRows(stored: RecordedRow, next: CaptureRow): Change {
  if (stored.cells.length === next.cells.length && stored.cells.every((value, column) => value === next.cells[column])) return 'same';
  const before = filled(stored.cells);
  const after = filled(next.cells);
  if (after <= 1 && before > 1) return 'downgrade';
  if (before <= 1 && after > 1) return 'upgrade';
  return identifier(stored.cells) === identifier(next.cells) ? 'update' : 'conflict';
}

function filled(cells: readonly string[]): number {
  return cells.reduce((count, value) => count + (value.trim() ? 1 : 0), 0);
}

function identifier(cells: readonly string[]): string {
  return cells.find((value) => value.trim() !== '')?.trim() ?? '';
}

/**
 * Inserts the new rows of a capture next to the known rows they appeared with: after the
 * known row before them, or before the first known row when they came first. A capture
 * with no known rows at all (a new page) goes to the end.
 */
function placeNewRows(recording: Recording, keys: readonly string[], fresh: ReadonlySet<string>): void {
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  let anchor: string | null = null;
  let pending: string[] = [];
  for (const key of keys) {
    if (fresh.has(key)) {
      if (anchor === null) pending.push(key);
      else after.get(anchor)?.push(key);
      continue;
    }
    if (pending.length > 0) {
      before.set(key, pending);
      pending = [];
    }
    anchor = key;
    after.set(key, []);
  }
  const order: string[] = [];
  for (const key of recording.order) {
    const first = before.get(key);
    if (first) order.push(...first);
    order.push(key);
    const next = after.get(key);
    if (next) order.push(...next);
  }
  order.push(...pending);
  recording.order = order;
}

/**
 * The recorded table: the first capture's header, then every row (by aria-rowindex when
 * every row has one, otherwise in page order). Columns empty everywhere are dropped.
 */
export function recordingToTable(recording: Recording): TableData {
  const body = recording.order.map((key) => recording.rows.get(key)).filter((row): row is RecordedRow => row !== undefined);
  if (body.length > 0 && body.every((row) => row.index !== null)) body.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const width = recording.width;
  const pad = (row: readonly string[]) => Array.from({ length: width }, (_, column) => row[column] ?? '');
  const rows = [...recording.header.map(pad), ...body.map((row) => pad(row.cells))];
  const hasLinks = body.some((row) => row.links?.some(Boolean));
  const links = hasLinks ? [...recording.header.map(() => pad([])), ...body.map((row) => pad(row.links ?? []))] : null;

  const keep: number[] = [];
  for (let column = 0; column < width; column++) if (rows.some((row) => (row[column] ?? '').trim() !== '')) keep.push(column);
  const cut = (row: readonly string[]) => keep.map((column) => row[column] ?? '');
  const data: TableData = {
    rows: keep.length > 0 ? rows.map(cut) : [],
    headerRows: keep.length > 0 ? recording.header.length : 0,
    width: keep.length,
    truncated: recording.truncated,
  };
  if (links && keep.length > 0) data.links = links.map(cut);
  return data;
}

function rowText(cells: readonly string[]): string {
  return cells.map((value) => value.trim()).join('\u0000');
}

/** cyrb53: a fast 53-bit string hash. Keys stay short however long the row is. */
export function rowHash(cells: readonly string[]): string {
  const text = `${cells.length}\u0001${cells.join('\u0000')}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// --- Stored recording -----------------------------------------------------------------------

/**
 * The recording as kept in chrome.storage.local, so the rows survive the page navigating
 * away (which ends the recorder with the page) and the popup can export them.
 */
export interface StoredRecording {
  id: string;
  tabId: number;
  /** The table's title in the popup (caption, heading or "Table N"). */
  title: string;
  pageTitle: string;
  url: string;
  decimal: DecimalSeparator;
  state: 'recording' | 'stopped';
  /** Why it stopped on its own. */
  ended?: 'table-gone' | 'navigated';
  startedAt: number;
  updatedAt: number;
  /** Body rows recorded. */
  rowCount: number;
  table: TableData;
  /** Storage only holds the first part of a very large recording; the in-page bar has it all. */
  partial: boolean;
}

/** Cells kept in storage (chrome.storage.local holds 10 MB, shared with the basket). */
export const STORED_RECORDING_CELLS = 250_000;

/** The table cut to what fits in storage. */
export function storableTable(table: TableData, maxCells = STORED_RECORDING_CELLS): { table: TableData; partial: boolean } {
  const perRow = Math.max(1, table.width);
  const maxRows = Math.max(table.headerRows, Math.floor(maxCells / perRow));
  if (table.rows.length <= maxRows) return { table, partial: false };
  const cut: TableData = { ...table, rows: table.rows.slice(0, maxRows) };
  if (table.links) cut.links = table.links.slice(0, maxRows);
  return { table: cut, partial: true };
}

function isStringGrid(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'));
}

/** Accepts anything read from storage; null when it isn't a usable recording. */
export function sanitizeRecording(raw: unknown): StoredRecording | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const table = value.table as Record<string, unknown> | undefined;
  if (typeof value.id !== 'string' || typeof table !== 'object' || table === null || !isStringGrid(table.rows)) return null;
  const width = table.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const rows = table.rows.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? ''));
  const headerRows = typeof table.headerRows === 'number' ? Math.min(Math.max(0, Math.floor(table.headerRows)), rows.length) : 0;
  const data: TableData = { rows, headerRows, width, truncated: table.truncated === true };
  if (isStringGrid(table.links) && table.links.length === rows.length) {
    data.links = table.links.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? ''));
  }
  const recording: StoredRecording = {
    id: value.id,
    tabId: typeof value.tabId === 'number' ? value.tabId : -1,
    title: typeof value.title === 'string' ? value.title : '',
    pageTitle: typeof value.pageTitle === 'string' ? value.pageTitle : '',
    url: typeof value.url === 'string' ? value.url : '',
    decimal: value.decimal === ',' ? ',' : '.',
    state: value.state === 'recording' ? 'recording' : 'stopped',
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    rowCount: typeof value.rowCount === 'number' ? value.rowCount : Math.max(0, rows.length - headerRows),
    table: data,
    partial: value.partial === true,
  };
  if (value.ended === 'table-gone' || value.ended === 'navigated') recording.ended = value.ended;
  return recording;
}
