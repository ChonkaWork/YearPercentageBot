import { describe, expect, it } from 'vitest';
import { columnLabels, columnSample, filterColumns, initialColumns, isIdentity, moveColumn, moveColumnTo, moveVisibleColumn, pickColumns, selectedColumns } from '../src/core/columns';
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

describe('drag and drop', () => {
  it('moves a column before another one, or to the end', () => {
    expect(moveColumnTo([0, 1, 2, 3], 3, 0)).toEqual([3, 0, 1, 2]);
    expect(moveColumnTo([0, 1, 2, 3], 0, 2)).toEqual([1, 0, 2, 3]);
    expect(moveColumnTo([0, 1, 2, 3], 1, null)).toEqual([0, 2, 3, 1]);
  });

  it('ignores drops on itself and unknown columns', () => {
    expect(moveColumnTo([0, 1, 2], 1, 1)).toEqual([0, 1, 2]);
    expect(moveColumnTo([0, 1, 2], 7, 0)).toEqual([0, 1, 2]);
    expect(moveColumnTo([0, 1, 2], 0, 9)).toEqual([0, 1, 2]);
  });
});

describe('filter', () => {
  const labels = ['Product', 'SKU', 'Price (USD)', 'Stock'];
  const samples = ['Green tea, Black coffee', '00731, 00732', '3.50, 4.20', '1,250, 980'];

  it('matches labels and sample values, case-insensitively; an empty filter shows everything', () => {
    expect([...filterColumns(labels, samples, 'pr')]).toEqual([0, 2]);
    expect([...filterColumns(labels, samples, 'COFFEE')]).toEqual([0]);
    expect([...filterColumns(labels, samples, '  ')]).toEqual([0, 1, 2, 3]);
    expect([...filterColumns(labels, samples, 'zzz')]).toEqual([]);
  });

  it('moves among the filtered columns, leaving hidden ones in place', () => {
    const visible = new Set([0, 2, 3]);
    expect(moveVisibleColumn([0, 1, 2, 3], 2, -1, visible)).toEqual([2, 1, 0, 3]);
    expect(moveVisibleColumn([0, 1, 2, 3], 3, -1, visible)).toEqual([0, 1, 3, 2]);
    expect(moveVisibleColumn([0, 1, 2, 3], 0, -1, visible)).toEqual([0, 1, 2, 3]);
    expect(moveVisibleColumn([0, 1, 2, 3], 3, 1, visible)).toEqual([0, 1, 2, 3]);
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
