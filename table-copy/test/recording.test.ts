import { describe, expect, it } from 'vitest';
import {
  captureFrom,
  mergeCapture,
  recordedRowCount,
  recordingToTable,
  rowHash,
  sanitizeRecording,
  startRecording,
  storableTable,
  type Capture,
  type CaptureRow,
} from '../src/core/recording';
import type { TableData } from '../src/core/table';

const header = [['ID', 'Name', 'Amount']];
const row = (index: number | null, id: string, name = `Customer ${id}`, amount = `${id}.00`): CaptureRow => ({ index, cells: [id, name, amount], links: null });
const capture = (rows: CaptureRow[], head = header): Capture => ({ header: head, rows, width: 3 });

/** A virtualized grid showing rows [from, to] (1-based data rows; aria-rowindex = n + 1). */
const window = (from: number, to: number) => capture(Array.from({ length: to - from + 1 }, (_, i) => row(from + i + 1, String(from + i))));

const ids = (data: TableData) => data.rows.slice(data.headerRows).map((cells) => cells[0]);

describe('recording a virtualized grid (aria-rowindex)', () => {
  it('collects every row once, in index order, whatever order they were scrolled into view', () => {
    const recording = startRecording(window(1, 20));
    expect(recordedRowCount(recording)).toBe(20);
    // Jump to the end, then scroll back up in overlapping windows.
    expect(mergeCapture(recording, window(81, 100))).toBe(20);
    for (let start = 61; start >= 11; start -= 10) mergeCapture(recording, window(start, start + 19));
    expect(mergeCapture(recording, window(1, 20))).toBe(0);
    const data = recordingToTable(recording);
    expect(data.headerRows).toBe(1);
    expect(data.rows[0]).toEqual(['ID', 'Name', 'Amount']);
    expect(ids(data)).toEqual(Array.from({ length: 100 }, (_, i) => String(i + 1)));
  });

  it('lets a loaded row replace its "Loading…" placeholder, never the other way round', () => {
    const recording = startRecording(capture([row(2, '1'), { index: 3, cells: ['Loading…', '', ''], links: null }]));
    mergeCapture(recording, capture([row(3, '2')]));
    mergeCapture(recording, capture([{ index: 2, cells: ['Loading…', '', ''], links: null }]));
    expect(recordingToTable(recording).rows.slice(1)).toEqual([
      ['1', 'Customer 1', '1.00'],
      ['2', 'Customer 2', '2.00'],
    ]);
  });

  it('updates live values of a row in place (same first value)', () => {
    const recording = startRecording(capture([row(2, '1', 'Ann', '10.00'), row(3, '2', 'Bob', '5.00')]));
    mergeCapture(recording, capture([row(2, '1', 'Ann', '12.50'), row(3, '2', 'Bob', '5.00')]));
    expect(recordedRowCount(recording)).toBe(2);
    expect(recordingToTable(recording).rows[1]).toEqual(['1', 'Ann', '12.50']);
  });

  it('appends pages that number their rows from 1 again instead of overwriting the first page', () => {
    const page = (first: number) => capture([1, 2, 3].map((n) => row(n + 1, String(first + n - 1))));
    const recording = startRecording(page(1));
    mergeCapture(recording, page(4));
    mergeCapture(recording, page(4)); // the same page captured again
    mergeCapture(recording, page(7));
    expect(ids(recordingToTable(recording))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    // "Previous" back to pages seen before adds nothing.
    expect(mergeCapture(recording, page(4))).toBe(0);
    expect(mergeCapture(recording, page(1))).toBe(0);
    expect(mergeCapture(recording, page(10))).toBe(3);
    expect(ids(recordingToTable(recording))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  });
});

describe('recording paginated tables (no indexes)', () => {
  it('appends each new page in order and ignores pages seen before', () => {
    const page = (first: number) => capture(Array.from({ length: 3 }, (_, i) => row(null, String(first + i))));
    const recording = startRecording(page(1));
    expect(mergeCapture(recording, page(4))).toBe(3);
    expect(mergeCapture(recording, page(7))).toBe(3);
    expect(mergeCapture(recording, page(4))).toBe(0); // "Previous" goes back
    expect(ids(recordingToTable(recording))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('keeps identical rows that a page really shows twice, but not their re-captures', () => {
    const twice = capture([row(null, 'A'), row(null, 'B', 'Same', '1.00'), row(null, 'B', 'Same', '1.00')]);
    const recording = startRecording(twice);
    mergeCapture(recording, twice);
    expect(ids(recordingToTable(recording))).toEqual(['A', 'B', 'B']);
  });

  it('places new rows next to the rows they appeared with (scrolling up an unindexed list)', () => {
    const rows = (...names: string[]) => capture(names.map((name) => row(null, name)));
    const recording = startRecording(rows('4', '5', '6'));
    mergeCapture(recording, rows('2', '3', '4', '5'));
    mergeCapture(recording, rows('1', '2'));
    mergeCapture(recording, rows('6', '7'));
    expect(ids(recordingToTable(recording))).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('skips empty rows and repeated header rows', () => {
    const recording = startRecording(capture([row(null, '1')]));
    mergeCapture(recording, capture([{ index: null, cells: ['ID', 'Name', 'Amount'], links: null }, { index: null, cells: ['', ' ', ''], links: null }, row(null, '2')], []));
    expect(ids(recordingToTable(recording))).toEqual(['1', '2']);
  });
});

describe('the recorded table', () => {
  it('keeps the first header, pads rows to the widest capture and drops columns that stayed empty', () => {
    const recording = startRecording({ header: [['', 'Name', 'Total', '']], rows: [{ index: null, cells: ['', 'Ann', '1', ''], links: null }], width: 4 });
    mergeCapture(recording, { header: [], rows: [{ index: null, cells: ['', 'Bob', '2', '', 'extra'], links: null }], width: 5 });
    const data = recordingToTable(recording);
    expect(data).toEqual({ rows: [['Name', 'Total', ''], ['Ann', '1', ''], ['Bob', '2', 'extra']], headerRows: 1, width: 3, truncated: false });
  });

  it('keeps links of recorded cells', () => {
    const recording = startRecording(capture([{ index: 2, cells: ['1', 'Ann', '3'], links: ['', 'https://example.com/ann', ''] }]));
    expect(recordingToTable(recording).links).toEqual([
      ['', '', ''],
      ['', 'https://example.com/ann', ''],
    ]);
  });

  it('builds captures from page reads, with row indexes and links', () => {
    const data: TableData = {
      rows: [['H'], ['a'], ['b']],
      headerRows: 1,
      width: 1,
      truncated: false,
      rowIndexes: [1, 7, null],
      links: [[''], ['https://example.com/a'], ['']],
    };
    expect(captureFrom(data)).toEqual({
      header: [['H']],
      rows: [
        { index: 7, cells: ['a'], links: ['https://example.com/a'] },
        { index: null, cells: ['b'], links: null },
      ],
      width: 1,
    });
  });

  it('hashes rows by content (order and position matter)', () => {
    expect(rowHash(['a', 'b'])).toBe(rowHash(['a', 'b']));
    expect(rowHash(['a', 'b'])).not.toBe(rowHash(['b', 'a']));
    expect(rowHash(['ab'])).not.toBe(rowHash(['a', 'b']));
  });
});

describe('the stored recording', () => {
  it('fits large recordings into storage, keeping the header', () => {
    const data: TableData = { rows: [['H1', 'H2'], ...Array.from({ length: 10 }, (_, i) => [String(i), 'x'])], headerRows: 1, width: 2, truncated: false };
    const { table, partial } = storableTable(data, 10);
    expect(partial).toBe(true);
    expect(table.rows).toHaveLength(5);
    expect(table.rows[0]).toEqual(['H1', 'H2']);
    expect(storableTable(data, 1000)).toEqual({ table: data, partial: false });
  });

  it('sanitizes what storage returns', () => {
    expect(sanitizeRecording(null)).toBeNull();
    expect(sanitizeRecording({ id: 'x', table: { rows: 'nope' } })).toBeNull();
    const recording = sanitizeRecording({
      id: 'r1',
      tabId: 7,
      title: 'Orders',
      url: 'https://app.example.com/orders',
      decimal: ',',
      state: 'recording',
      ended: 'navigated',
      rowCount: 2,
      table: { rows: [['A', 'B'], ['1'], ['2', '3']], headerRows: 1, links: [['', ''], ['', ''], ['', 'https://example.com/3']] },
      partial: 'yes',
    });
    expect(recording).toMatchObject({
      id: 'r1',
      tabId: 7,
      title: 'Orders',
      pageTitle: '',
      decimal: ',',
      state: 'recording',
      ended: 'navigated',
      rowCount: 2,
      partial: false,
      table: { rows: [['A', 'B'], ['1', ''], ['2', '3']], headerRows: 1, width: 2, truncated: false },
    });
    expect(recording?.table.links?.[2]).toEqual(['', 'https://example.com/3']);
    expect(sanitizeRecording({ id: 'r2', state: 'weird', table: { rows: [['a']] } })).toMatchObject({ state: 'stopped', tabId: -1, rowCount: 1, table: { headerRows: 0 } });
  });
});
