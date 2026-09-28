import { describe, expect, it } from 'vitest';
import { addToBasket, basketItemFrom, basketSheets, cellCount, commonDecimal, itemHost, itemLabel, mergeBasket, mergedColumns, removeFromBasket, sanitizeBasket, type BasketItem } from '../src/core/basket';
import { limitsFor } from '../src/core/plan';
import { table } from './helpers';

const limits = { basketTables: 3, basketCells: 100 };

function item(id: string, rows: string[][], title = '', url = `https://shop.example/${id}`, decimal: '.' | ',' = '.'): BasketItem {
  return basketItemFrom(table(rows), { title, pageTitle: `Page ${id}`, url, decimal }, id, 1);
}

const january = item('jan', [['Product', 'Price'], ['Tea', '3.50'], ['Coffee', '4.20']], 'January');
const february = item('feb', [['Price', 'Product', 'Stock'], ['3.60', 'Tea', '12']], 'February');

describe('basketItemFrom', () => {
  it('keeps unique column keys and body rows', () => {
    const grouped = basketItemFrom(table([['Region', 'Population', 'Population', ''], ['Region', '2010', '2020', ''], ['North', '1', '2', 'x']], 2), { title: 'T', pageTitle: 'P', url: 'https://a.example/', decimal: ',' }, 'id', 5);
    expect(grouped).toEqual({
      id: 'id',
      title: 'T',
      pageTitle: 'P',
      url: 'https://a.example/',
      addedAt: 5,
      columns: ['Region', 'Population / 2010', 'Population / 2020', 'Column 4'],
      rows: [['North', '1', '2', 'x']],
      decimal: ',',
    });
    expect(item('x', [['a', 'b']], '', '').columns).toEqual(['a', 'b']);
    expect(basketItemFrom(table([['1', '2']], 0), { title: '', pageTitle: '', url: '', decimal: '.' }, 'n', 0)).toMatchObject({ columns: ['Column 1', 'Column 2'], rows: [['1', '2']] });
  });
});

describe('addToBasket', () => {
  it('adds within the limits', () => {
    const first = addToBasket([], january, limits);
    expect(first.ok && first.items.map((entry) => entry.id)).toEqual(['jan']);
  });

  it('refuses empty tables, duplicates, a full basket and too many cells', () => {
    expect(addToBasket([], item('e', [['A']]), limits)).toEqual({ ok: false, reason: 'empty' });
    expect(addToBasket([january], { ...january, id: 'again' }, limits)).toEqual({ ok: false, reason: 'duplicate' });
    const three = [january, february, item('mar', [['A'], ['1']])];
    expect(addToBasket(three, item('apr', [['A'], ['2']]), limits)).toEqual({ ok: false, reason: 'full' });
    const big = item('big', [['A', 'B'], ...Array.from({ length: 60 }, (_, i) => [String(i), 'x'])]);
    expect(addToBasket([january], big, limits)).toEqual({ ok: false, reason: 'too-big' });
    expect(cellCount([january, february])).toBe(4 + 3);
  });

  it('is not allowed without the Pro limits', () => {
    expect(addToBasket([], january, limitsFor('free', false))).toEqual({ ok: false, reason: 'not-allowed' });
    expect(addToBasket([], january, limitsFor('pro', false)).ok).toBe(true);
  });

  it('removes by id', () => {
    expect(removeFromBasket([january, february], 'jan').map((entry) => entry.id)).toEqual(['feb']);
  });
});

describe('mergeBasket', () => {
  it('stacks rows and lines columns up by name, in order of first appearance', () => {
    expect(mergeBasket([january, february], { source: false }).rows).toEqual([
      ['Product', 'Price', 'Stock'],
      ['Tea', '3.50', ''],
      ['Coffee', '4.20', ''],
      ['Tea', '3.60', '12'],
    ]);
  });

  it('adds Source and Source URL columns first when asked', () => {
    const merged = mergeBasket([january, february], { source: true });
    expect(merged.headerRows).toBe(1);
    expect(merged.width).toBe(5);
    expect(merged.rows[0]).toEqual(['Source', 'Source URL', 'Product', 'Price', 'Stock']);
    expect(merged.rows[3]).toEqual(['February', 'https://shop.example/feb', 'Tea', '3.60', '12']);
  });

  it('renames the source columns when a table already has one called Source', () => {
    const withSource = item('s', [['Source', 'Value'], ['x', '1']]);
    expect(mergeBasket([withSource], { source: true }).rows[0]).toEqual(['Source (2)', 'Source URL', 'Source', 'Value']);
  });

  it('merges tables without headers by position', () => {
    const a = item('a', [['1', '2']].concat([['3', '4']]));
    const plain = basketItemFrom(table([['x', 'y']], 0), { title: '', pageTitle: '', url: '', decimal: '.' }, 'p', 0);
    const plain2 = basketItemFrom(table([['z', 'w', 'v']], 0), { title: '', pageTitle: '', url: '', decimal: '.' }, 'q', 0);
    expect(mergeBasket([plain, plain2], { source: false }).rows).toEqual([['Column 1', 'Column 2', 'Column 3'], ['x', 'y', ''], ['z', 'w', 'v']]);
    expect(a.columns).toEqual(['1', '2']);
  });

  it('is empty for an empty basket', () => {
    expect(mergeBasket([], { source: true })).toMatchObject({ rows: [], width: 0 });
  });
});

describe('labels and sheets', () => {
  it('labels items by table title, page title, host, or position', () => {
    expect(itemLabel(january, 0)).toBe('January');
    expect(itemLabel({ ...january, title: ' ' }, 0)).toBe('Page jan');
    expect(itemLabel({ ...january, title: '', pageTitle: '' }, 0)).toBe('shop.example');
    expect(itemLabel({ ...january, title: '', pageTitle: '', url: 'nope' }, 4)).toBe('Table 5');
    expect(itemHost(january)).toBe('shop.example');
    expect(itemHost({ ...january, url: '' })).toBe('');
  });

  it('builds one stacked sheet or one sheet per table', () => {
    const stacked = basketSheets([january, february], { source: true, layout: 'stack' });
    expect(stacked).toHaveLength(1);
    expect(stacked[0]).toMatchObject({ name: 'Merged tables', headerRows: 1, decimal: '.' });
    expect(stacked[0]!.rows).toHaveLength(4);
    const separate = basketSheets([january, february], { source: false, layout: 'sheets' });
    expect(separate.map((sheet) => sheet.name)).toEqual(['January', 'February']);
    expect(separate[1]!.rows).toEqual([['Price', 'Product', 'Stock'], ['3.60', 'Tea', '12']]);
    const withSource = basketSheets([january], { source: true, layout: 'sheets' });
    expect(withSource[0]!.rows[1]).toEqual(['January', 'https://shop.example/jan', 'Tea', '3.50']);
  });

  it('keeps a stacked sheet as text when the pages disagree on the decimal separator', () => {
    const german = item('de', [['Preis'], ['3,50']], 'Preise', 'https://shop.example/de', ',');
    expect(commonDecimal([january, february])).toBe('.');
    expect(commonDecimal([january, german])).toBeNull();
    expect(basketSheets([january, german], { source: false, layout: 'stack' })[0]!.decimal).toBeNull();
    expect(basketSheets([january, german], { source: false, layout: 'sheets' }).map((sheet) => sheet.decimal)).toEqual(['.', ',']);
  });
});

describe('sanitizeBasket', () => {
  it('keeps valid items, repairs ragged rows and drops junk', () => {
    const raw = [
      { ...january, rows: [['Tea'], ['Coffee', '4.20', 'extra']] },
      { id: 1, columns: ['a'], rows: [] },
      { id: 'x', columns: ['a'], rows: [[1]] },
      null,
      'nope',
      { id: 'min', columns: ['a'], rows: [['1']] },
    ];
    const items = sanitizeBasket(raw);
    expect(items.map((entry) => entry.id)).toEqual(['jan', 'min']);
    expect(items[0]!.rows).toEqual([['Tea', ''], ['Coffee', '4.20']]);
    expect(items[1]).toEqual({ id: 'min', title: '', pageTitle: '', url: '', addedAt: 0, columns: ['a'], rows: [['1']], decimal: '.' });
    expect(sanitizeBasket(undefined)).toEqual([]);
    expect(sanitizeBasket({})).toEqual([]);
  });
});

describe('mergedColumns', () => {
  it('reports which tables have each merged column, in merge order', () => {
    expect(mergedColumns([january, february])).toEqual([
      { name: 'Product', tables: [0, 1] },
      { name: 'Price', tables: [0, 1] },
      { name: 'Stock', tables: [1] },
    ]);
    expect(mergedColumns([])).toEqual([]);
  });
});
