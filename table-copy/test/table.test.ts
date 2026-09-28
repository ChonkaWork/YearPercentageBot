import { describe, expect, it } from 'vitest';
import { tableDataFromSnapshot } from '../src/core/extract';
import { el, type SnapElement } from '../src/core/snapshot';
import { buildTableModel, combineHeaderRows, layoutGrid } from '../src/core/table';

const td = (value: string | SnapElement, attrs: { colspan?: number; rowspan?: number } = {}) => el('td', attrs, value);
const th = (value: string, attrs: { colspan?: number; rowspan?: number } = {}) => el('th', attrs, value);
const tr = (...cells: SnapElement[]) => el('tr', null, ...cells);

describe('layoutGrid', () => {
  const layout = (rows: number[][][]) =>
    layoutGrid([rows], ([colSpan, rowSpan]: number[]) => ({ colSpan: colSpan ?? 1, rowSpan: rowSpan ?? 1 }));

  it('expands colspan and rowspan into a rectangular grid', () => {
    const grid = layout([[[2, 1], [1, 2]], [[1, 1], [1, 1]]]);
    expect(grid.width).toBe(3);
    expect(grid.rows.map((row) => row.map((slot) => (slot ? (slot.origin ? 'O' : 's') : '.')).join(''))).toEqual(['OsO', 'OOs']);
  });

  it('pads ragged rows and clips rowspan at the end of the row group', () => {
    const grid = layoutGrid([[['a', 'b'], ['c']], [['d']]], (cell: string) => ({ colSpan: 1, rowSpan: cell === 'b' ? 5 : 1 }));
    expect(grid.rows.map((row) => row.map((slot) => slot?.cell ?? '.').join(''))).toEqual(['ab', 'cb', 'd.']);
  });

  it('treats rowspan=0 as "to the end of the group" and survives absurd spans', () => {
    const grid = layoutGrid([[['a', 'b'], ['c'], ['d']]], (cell: string) =>
      cell === 'a' ? { colSpan: 1, rowSpan: 0 } : cell === 'b' ? { colSpan: 1e9, rowSpan: 1 } : { colSpan: 1, rowSpan: 1 },
    );
    expect(grid.width).toBe(1000);
    expect(grid.rows.map((row) => row[0]?.cell)).toEqual(['a', 'a', 'a']);
    expect(grid.rows[1]?.[1]?.cell).toBe('c');
  });
});

describe('header detection', () => {
  it('uses <thead> rows, leading <th> rows, or a first row of bold cells', () => {
    expect(buildTableModel(el('table', null, el('thead', null, tr(th('Name'), th('Age'))), el('tbody', null, tr(td('Ann'), td('31'))))).headerRows).toBe(1);
    expect(buildTableModel(el('table', null, el('tbody', null, tr(th('Name'), th('Age')), tr(th('Ann'), td('31'))))).headerRows).toBe(1);
    const bold = (value: string) => td(el('b', null, value));
    expect(buildTableModel(el('table', null, el('tbody', null, tr(bold('Plan'), bold('Price')), tr(td('Free'), td('$0'))))).headerRows).toBe(1);
    expect(buildTableModel(el('table', null, el('tbody', null, tr(td('a'), td('b')), tr(td('c'), td('d'))))).headerRows).toBe(0);
  });

  it('orders thead first and tfoot last, like HTMLTableElement.rows', () => {
    const table = el('table', null, el('tfoot', null, tr(td('Total'), td('3'))), el('tbody', null, tr(td('x'), td('3'))), el('thead', null, tr(th('Item'), th('Qty'))));
    expect(tableDataFromSnapshot(table).rows).toEqual([['Item', 'Qty'], ['x', '3'], ['Total', '3']]);
  });
});

describe('tableDataFromSnapshot', () => {
  it('repeats spanned values, drops empty rows and trailing empty columns', () => {
    const table = el(
      'table',
      null,
      el('thead', null, tr(th('Region', { rowspan: 2 }), th('Population', { colspan: 2 }), th('')), tr(th('2010'), th('2020'))),
      el('tbody', null, tr(td('North'), td('1,200'), td('1,350'), td('')), tr(td(''), td(''), td(''), td('')), tr(td('South', { colspan: 3 }))),
    );
    const result = tableDataFromSnapshot(table);
    expect(result.headerRows).toBe(2);
    expect(result.rows).toEqual([
      ['Region', 'Population', 'Population'],
      ['Region', '2010', '2020'],
      ['North', '1,200', '1,350'],
      ['South', 'South', 'South'],
    ]);
    expect(combineHeaderRows(result)).toEqual(['Region', 'Population / 2010', 'Population / 2020']);
  });

  it('keeps line breaks inside cells, collapses spaces and uses image alt text for icon-only cells', () => {
    const table = el('table', null, tr(td(el('div', null, el('p', null, 'First   line'), el('p', null, 'Second line'))), td(el('img', { alt: 'Yes', src: 'https://x/y.png' }))));
    expect(tableDataFromSnapshot(table).rows).toEqual([['First line\nSecond line', 'Yes']]);
  });

  it('keeps a nested table inside its cell instead of mixing it into the outer grid', () => {
    const inner = el('table', null, tr(td('i1'), td('i2')), tr(td('i3'), td('i4')));
    const result = tableDataFromSnapshot(el('table', null, tr(th('Outer'), th('Detail')), tr(td('o1'), td(inner))));
    expect(result.width).toBe(2);
    expect(result.rows[1]).toEqual(['o1', 'i1 i2\ni3 i4']);
  });

  it('returns an empty grid for an empty table', () => {
    expect(tableDataFromSnapshot(el('table', null))).toMatchObject({ rows: [], width: 0, headerRows: 0 });
  });
});
