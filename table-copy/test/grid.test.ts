import { describe, expect, it } from 'vitest';
import { arrangeGrid, positiveInt, type GridCell, type GridRow } from '../src/core/grid';

const cell = (value: string, extra: Partial<GridCell<string>> = {}): GridCell<string> => ({ value, header: false, ...extra });
const head = (value: string, extra: Partial<GridCell<string>> = {}): GridCell<string> => ({ value, header: true, ...extra });
const values = (grid: ReturnType<typeof arrangeGrid<string>>) => grid.rows.map((row) => row.cells.map((entry) => entry?.value ?? '.'));

describe('arrangeGrid', () => {
  it('orders rows by aria-rowindex, as virtualized grids append them in any order', () => {
    const rows: GridRow<string>[] = [
      { rowIndex: 4, cells: [cell('c')] },
      { rowIndex: 1, cells: [head('H')] },
      { rowIndex: 3, cells: [cell('b')] },
      { rowIndex: 2, cells: [cell('a')] },
    ];
    const grid = arrangeGrid(rows);
    expect(values(grid)).toEqual([['H'], ['a'], ['b'], ['c']]);
    expect(grid.rows.map((row) => row.rowIndex)).toEqual([1, 2, 3, 4]);
    expect(grid.headerRows).toBe(1);
  });

  it('merges rows that share an index (AG Grid pinned and scrolling containers) and places cells by aria-colindex', () => {
    const rows: GridRow<string>[] = [
      { rowIndex: 1, cells: [head('Athlete', { colIndex: 1 })] },
      { rowIndex: 2, cells: [cell('Phelps', { colIndex: 1 })] },
      { rowIndex: 1, cells: [head('Gold', { colIndex: 3 }), head('Age', { colIndex: 2 })] },
      { rowIndex: 2, cells: [cell('8', { colIndex: 3 }), cell('23', { colIndex: 2 })] },
    ];
    expect(values(arrangeGrid(rows))).toEqual([
      ['Athlete', 'Age', 'Gold'],
      ['Phelps', '23', '8'],
    ]);
  });

  it('fills gaps with empty cells and honours aria-colspan', () => {
    const grid = arrangeGrid([
      { rowIndex: 1, cells: [head('Athlete details', { colIndex: 1, colSpan: 2 }), head('Medals', { colIndex: 3, colSpan: 2 })] },
      { rowIndex: 2, cells: [head('Name', { colIndex: 1 }), head('Age', { colIndex: 2 }), head('Gold', { colIndex: 3 }), head('Silver', { colIndex: 4 })] },
      { rowIndex: 3, cells: [cell('Phelps', { colIndex: 1 }), cell('2', { colIndex: 4 })] },
    ]);
    expect(grid.width).toBe(4);
    expect(grid.headerRows).toBe(2);
    expect(values(grid)[0]).toEqual(['Athlete details', 'Medals']);
    expect(grid.rows[0]?.cells.map((entry) => entry?.colSpan)).toEqual([2, 2]);
    expect(values(grid)[2]).toEqual(['Phelps', '.', '.', '2']);
  });

  it('keeps unindexed rows after the row before them, and cells without an index after the previous cell', () => {
    const grid = arrangeGrid([
      { rowIndex: 2, cells: [cell('two')] },
      { cells: [cell('after two'), cell('x', { colIndex: 3 }), cell('y')] },
      { rowIndex: 1, cells: [cell('one')] },
    ]);
    expect(values(grid)).toEqual([['one'], ['two'], ['after two', '.', 'x', 'y']]);
    expect(grid.headerRows).toBe(0);
  });

  it('never lets two cells take the same column', () => {
    const grid = arrangeGrid([{ cells: [cell('a', { colIndex: 2 }), cell('b', { colIndex: 2 }), cell('c', { colIndex: 1 })] }]);
    expect(values(grid)).toEqual([['c', 'a', 'b']]);
  });

  it('drops cells beyond the column limit instead of building a huge row', () => {
    const grid = arrangeGrid([{ cells: [cell('a'), cell('far', { colIndex: 5000 })] }]);
    expect(values(grid)).toEqual([['a']]);
  });

  it('reads positive integer attributes only', () => {
    expect(positiveInt('3')).toBe(3);
    expect(positiveInt(' 12 ')).toBe(12);
    for (const value of ['0', '-1', '1.5', 'abc', '', null, undefined, '1e3']) expect(positiveInt(value)).toBeUndefined();
  });
});
