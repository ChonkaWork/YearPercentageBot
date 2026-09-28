import { describe, expect, it } from 'vitest';
import { columnLabels, columnSample, initialColumns, isIdentity, moveColumn, pickColumns, selectedColumns } from '../src/core/columns';
import { table } from './helpers';

const data = table([
  ['Plan', 'Price', 'Seats', 'Support'],
  ['Free', '$0', '1', ''],
  ['Pro', '$12', '5', 'Email'],
  ['', '', '', 'Phone'],
]);

describe('pickColumns', () => {
  it('keeps the chosen columns in the chosen order, header rows included', () => {
    const picked = pickColumns(data, [3, 0]);
    expect(picked).toEqual({ rows: [['Support', 'Plan'], ['', 'Free'], ['Email', 'Pro'], ['Phone', '']], headerRows: 1, width: 2, truncated: false });
  });

  it('drops body rows left without content, never header rows', () => {
    const picked = pickColumns(data, [1, 2]);
    expect(picked.rows).toEqual([['Price', 'Seats'], ['$0', '1'], ['$12', '5']]);
    expect(pickColumns(table([['', 'B'], ['x', '']]), [0]).rows).toEqual([[''], ['x']]);
  });

  it('ignores unknown and repeated indexes; the identity selection returns the same table', () => {
    expect(pickColumns(data, [1, 1, 9, -1, 1.5]).width).toBe(1);
    expect(pickColumns(data, [0, 1, 2, 3])).toBe(data);
  });

  it('returns an empty table when nothing is selected', () => {
    expect(pickColumns(data, [])).toMatchObject({ rows: [], width: 0, headerRows: 0 });
  });

  it('keeps several header rows', () => {
    const grouped = table([['Region', 'Population', 'Population'], ['Region', '2010', '2020'], ['North', '1', '2']], 2);
    expect(pickColumns(grouped, [2, 0]).rows).toEqual([['Population', 'Region'], ['2020', 'Region'], ['2', 'North']]);
  });
});

describe('picker state', () => {
  it('starts with every column on, in order', () => {
    const state = initialColumns(3);
    expect(selectedColumns(state)).toEqual([0, 1, 2]);
    expect(isIdentity(selectedColumns(state), 3)).toBe(true);
  });

  it('reorders and switches columns off', () => {
    const state = initialColumns(4);
    state.order = moveColumn(state.order, 3, -1);
    state.order = moveColumn(state.order, 0, 1);
    expect(state.order).toEqual([1, 0, 3, 2]);
    state.enabled.delete(0);
    expect(selectedColumns(state)).toEqual([1, 3, 2]);
    expect(isIdentity([1, 3, 2], 4)).toBe(false);
  });

  it('refuses moves past either end', () => {
    expect(moveColumn([0, 1, 2], 0, -1)).toEqual([0, 1, 2]);
    expect(moveColumn([0, 1, 2], 2, 1)).toEqual([0, 1, 2]);
    expect(moveColumn([0, 1, 2], 7, 1)).toEqual([0, 1, 2]);
  });
});

describe('labels', () => {
  it('uses the combined header or "Column N", with a sample of values', () => {
    expect(columnLabels(table([['Region', 'Population', ''], ['Region', '2010', '']], 2))).toEqual(['Region', 'Population / 2010', 'Column 3']);
    expect(columnLabels(table([['a', 'b']], 0))).toEqual(['Column 1', 'Column 2']);
    expect(columnSample(data, 3)).toBe('Email, Phone');
    expect(columnSample(table([['H'], ['a\n b'], ['c'], ['d'], ['e']]), 0)).toBe('a b, c, d');
  });
});
