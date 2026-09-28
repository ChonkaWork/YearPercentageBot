// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/core/formats';
import { findSelectedTable, findTableAt, listTables, overlappingTables, pageInfo, readTable, tableTitle } from '../src/page/reader';
import { $, render, selectContents, selectRange, textIn } from './helpers';

const page = `
  <h2>Plans</h2>
  <table id="t1"><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Free</td><td>$0</td></tr></tbody></table>
  <table id="t2"><caption>Population</caption>
    <thead><tr><th rowspan="2">City</th><th colspan="2">Population</th></tr><tr><th>2010</th><th>2020</th></tr></thead>
    <tbody><tr><td id="kyiv">Kyiv</td><td>2.8M</td><td>2.9M</td></tr><tr><td>Lviv</td><td>0.7M</td><td>0.7M</td></tr>
    <tr><td>Nested</td><td colspan="2"><table id="inner"><tr><td id="in1">i1</td><td>i2</td></tr></table></td></tr></tbody>
  </table>
  <table role="presentation"><tr><td>layout</td><td>table</td></tr></table>
  <div style="display:none"><table><tr><td>hidden</td><td>x</td></tr></table></div>
  <table><tr><td>single cell</td></tr></table>
  <p id="outside">Not a table</p>`;

function read(table: Element) {
  const result = readTable(table);
  if (result.status !== 'ok') throw new Error(result.status);
  return result;
}

describe('listTables', () => {
  it('lists visible data tables with size, title and preview; skips layout, hidden and one-cell tables', () => {
    render(page);
    const list = listTables(document);
    expect(list.total).toBe(3);
    const [first, second, inner] = list.tables;
    expect(first).toMatchObject({ title: 'Plans', rows: 2, columns: 2, headerRows: 1, preview: [['Plan', 'Price'], ['Free', '$0']] });
    expect(second).toMatchObject({ title: 'Population', rows: 5, columns: 3, headerRows: 2 });
    expect(second?.preview[0]).toEqual(['City', 'Population', 'Population']);
    expect(inner).toMatchObject({ rows: 1, columns: 2 });
  });

  it('caps the list and reports the total', () => {
    render(Array.from({ length: 5 }, (_, i) => `<table><tr><td>${i}</td><td>x</td></tr></table>`).join(''));
    const list = listTables(document, 2);
    expect(list.tables).toHaveLength(2);
    expect(list.total).toBe(5);
  });

  it('previews at most 6 columns and shortens long values', () => {
    render(`<table><tr>${Array.from({ length: 9 }, (_, i) => `<th>H${i}</th>`).join('')}</tr><tr><td>${'long '.repeat(30)}</td>${'<td>v</td>'.repeat(8)}</tr></table>`);
    const [summary] = listTables(document).tables;
    expect(summary?.columns).toBe(9);
    expect(summary?.preview[0]).toHaveLength(6);
    expect(summary?.preview[1]?.[0]?.endsWith('…')).toBe(true);
    expect(summary?.preview[1]?.[0]?.length).toBeLessThanOrEqual(48);
  });
});

describe('reading tables', () => {
  it('reads a listed table again as a grid, and notices when the page changed', () => {
    render(page);
    const summary = listTables(document).tables[1]!;
    const table = findTableAt(document, summary.index, summary.signature);
    expect(table).not.toBeNull();
    const result = read(table!);
    expect(result.title).toBe('Population');
    expect(result.data.headerRows).toBe(2);
    expect(toCsv(result.data)).toBe('City,Population,Population\nCity,2010,2020\nKyiv,2.8M,2.9M\nLviv,0.7M,0.7M\nNested,i1 i2,i1 i2');
    $('#t2 thead tr th').textContent = 'Town';
    expect(findTableAt(document, summary.index, summary.signature)).toBeNull();
  });

  it('finds the table around the selection (innermost first) or overlapping it', () => {
    render(page);
    selectContents($('#kyiv'));
    expect(findSelectedTable(document)).toBe($('#t2'));
    expect(overlappingTables(document)).toBe(1);
    selectContents($('#in1'));
    expect(findSelectedTable(document)).toBe($('#inner'));
    selectRange(textIn('h2'), 0, textIn('#kyiv'), 2);
    expect(findSelectedTable(document)).toBe($('#t1'));
    expect(overlappingTables(document)).toBe(2);
    selectContents($('#outside'));
    expect(findSelectedTable(document)).toEqual({ none: 'no-table' });
    window.getSelection()?.removeAllRanges();
    expect(findSelectedTable(document)).toEqual({ none: 'no-selection' });
  });

  it('skips hidden rows, hidden sort keys, footnote markers and controls', () => {
    render(`<table id="t"><tr><th>Name</th><th>Rank</th></tr>
      <tr><td>A<sup class="reference">[1]</sup></td><td><span style="display:none">0001</span>1 <button>Sort</button></td></tr>
      <tr style="display:none"><td>B</td><td>2</td></tr></table>`);
    expect(read($('#t')).data.rows).toEqual([['Name', 'Rank'], ['A', '1']]);
  });

  it('reports the page title, URL and decimal separator of its language', () => {
    render('<table id="t"><tr><td>a</td><td>b</td></tr></table>');
    document.title = 'Prices';
    document.documentElement.lang = 'de';
    expect(read($('#t')).page).toMatchObject({ pageTitle: 'Prices', decimal: ',' });
    document.documentElement.lang = '';
    expect(pageInfo(document).decimal).toBe('.');
  });

  it('titles tables by caption, aria-label, aria-labelledby or the nearest heading', () => {
    render(`<h3 id="h">Heading</h3><div><table id="a"><tr><td>1</td></tr></table></div>
      <table id="b" aria-label="  Labelled   table "><tr><td>1</td></tr></table>
      <p id="lbl">From <b>label</b></p><table id="c" aria-labelledby="lbl"><tr><td>1</td></tr></table>
      <table id="d"><tr><td>1</td></tr></table>`);
    expect(tableTitle($('#a'))).toBe('Heading');
    expect(tableTitle($('#b'))).toBe('Labelled table');
    expect(tableTitle($('#c'))).toBe('From label');
    expect(tableTitle($('#d'))).toBe('');
  });
});
