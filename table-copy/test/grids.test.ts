// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatTable, toCsv } from '../src/core/formats';
import { findSelectedTable, findTableAt, findTableAtPoint, listTables, readTable, readTableData } from '../src/page/reader';
import { $, render, selectContents } from './helpers';

/** Markup modelled on AG Grid (v31): pinned and scrolling containers, grouped header, floating filters. */
const agGrid = `
  <h2>Olympic winners</h2>
  <div class="ag-root-wrapper">
    <div id="ag" class="ag-root ag-unselectable ag-layout-normal" role="grid" aria-colcount="4" aria-rowcount="1003" aria-multiselectable="true">
      <div class="ag-header" role="presentation">
        <div class="ag-pinned-left-header" role="presentation">
          <div class="ag-header-row ag-header-row-column-group" role="row" aria-rowindex="1">
            <div class="ag-header-group-cell ag-header-group-cell-no-group" role="columnheader" aria-colindex="1"><span class="ag-header-group-text"></span></div>
          </div>
          <div class="ag-header-row ag-header-row-column" role="row" aria-rowindex="2">
            <div class="ag-header-cell" role="columnheader" aria-colindex="1" col-id="athlete" tabindex="-1" aria-sort="ascending">
              <div class="ag-header-cell-resize" role="presentation"></div>
              <div class="ag-header-cell-comp-wrapper" role="presentation">
                <div class="ag-cell-label-container" role="presentation">
                  <span class="ag-header-icon ag-header-cell-menu-button" aria-hidden="true"><span class="ag-icon ag-icon-menu" role="presentation">☰</span></span>
                  <div class="ag-header-cell-label" role="presentation">
                    <span class="ag-header-cell-text">Athlete</span>
                    <span class="ag-sort-indicator-container" role="presentation"><span class="ag-sort-order ag-hidden" aria-hidden="true">1</span></span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="ag-header-row ag-header-row-column-filter" role="row" aria-rowindex="3">
            <div class="ag-header-cell ag-floating-filter" role="columnheader" aria-colindex="1"><input class="ag-input-field-input" type="text" aria-label="Athlete Filter Input"></div>
          </div>
        </div>
        <div class="ag-header-viewport" role="presentation">
          <div class="ag-header-container" role="rowgroup">
            <div class="ag-header-row ag-header-row-column-group" role="row" aria-rowindex="1">
              <div class="ag-header-group-cell ag-header-group-cell-no-group" role="columnheader" aria-colindex="2"></div>
              <div class="ag-header-group-cell ag-header-group-cell-with-group" role="columnheader" aria-colindex="3" aria-colspan="2"><span class="ag-header-group-text">Medals</span></div>
            </div>
            <div class="ag-header-row ag-header-row-column" role="row" aria-rowindex="2">
              <div class="ag-header-cell" role="columnheader" aria-colindex="2" col-id="country" tabindex="-1"><span class="ag-header-cell-text">Country</span></div>
              <div class="ag-header-cell" role="columnheader" aria-colindex="3" col-id="gold" tabindex="-1"><span class="ag-header-cell-text">Gold</span></div>
              <div class="ag-header-cell" role="columnheader" aria-colindex="4" col-id="silver" tabindex="-1"><span class="ag-header-cell-text">Silver</span></div>
            </div>
            <div class="ag-header-row ag-header-row-column-filter" role="row" aria-rowindex="3">
              <div class="ag-header-cell ag-floating-filter" role="columnheader" aria-colindex="2"><input type="text"></div>
              <div class="ag-header-cell ag-floating-filter" role="columnheader" aria-colindex="3"><input type="number"></div>
              <div class="ag-header-cell ag-floating-filter" role="columnheader" aria-colindex="4"><input type="number"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="ag-body" role="presentation">
        <div class="ag-body-viewport" role="presentation">
          <div class="ag-pinned-left-cols-container" role="rowgroup">
            <div role="row" row-index="1" aria-rowindex="5" class="ag-row" style="transform: translateY(42px)">
              <div role="gridcell" aria-colindex="1" col-id="athlete" tabindex="-1" class="ag-cell"><span class="ag-selection-checkbox"><input type="checkbox" aria-label="Press Space to toggle row selection"></span><span class="ag-cell-value">Natalie Coughlin</span></div>
            </div>
            <div role="row" row-index="0" aria-rowindex="4" class="ag-row" style="transform: translateY(0px)">
              <div role="gridcell" aria-colindex="1" col-id="athlete" tabindex="-1" class="ag-cell" id="phelps"><span class="ag-cell-value">Michael Phelps</span></div>
            </div>
            <div role="row" row-index="2" aria-rowindex="6" class="ag-row" style="transform: translateY(84px)">
              <div role="gridcell" aria-colindex="1" col-id="athlete" tabindex="-1" class="ag-cell"><span class="ag-cell-value">Aleksey Nemov</span></div>
            </div>
          </div>
          <div class="ag-center-cols-viewport" role="presentation">
            <div class="ag-center-cols-container" role="rowgroup">
              <div role="row" row-index="2" aria-rowindex="6" class="ag-row">
                <div role="gridcell" aria-colindex="4" class="ag-cell">1</div>
                <div role="gridcell" aria-colindex="2" class="ag-cell">Russia</div>
                <div role="gridcell" aria-colindex="3" class="ag-cell">2</div>
              </div>
              <div role="row" row-index="0" aria-rowindex="4" class="ag-row">
                <div role="gridcell" aria-colindex="2" class="ag-cell">United States</div>
                <div role="gridcell" aria-colindex="3" class="ag-cell">8</div>
                <div role="gridcell" aria-colindex="4" class="ag-cell">0</div>
              </div>
              <div role="row" row-index="1" aria-rowindex="5" class="ag-row">
                <div role="gridcell" aria-colindex="2" class="ag-cell">United States</div>
                <div role="gridcell" aria-colindex="3" class="ag-cell">3</div>
                <div role="gridcell" aria-colindex="4" class="ag-cell ag-hidden">hidden</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="ag-overlay ag-hidden" aria-hidden="true"><div class="ag-overlay-loading-center">Loading...</div></div>
    </div>
  </div>`;

/** Markup modelled on MUI X DataGrid (v6): checkbox column, sort buttons, separators, filler cells, pagination. */
const muiGrid = `
  <div class="MuiDataGrid-root" id="mui" role="grid" aria-label="Orders" aria-colcount="4" aria-rowcount="4" aria-multiselectable="true">
    <div class="MuiDataGrid-main">
      <div class="MuiDataGrid-columnHeaders">
        <div class="MuiDataGrid-columnHeadersInner" role="row" aria-rowindex="1">
          <div class="MuiDataGrid-columnHeader MuiDataGrid-columnHeaderCheckbox" role="columnheader" aria-colindex="1" data-field="__check__" tabindex="-1">
            <div class="MuiDataGrid-columnHeaderTitleContainer"><span class="MuiCheckbox-root"><input type="checkbox" aria-label="Select all rows"></span></div>
          </div>
          <div class="MuiDataGrid-columnHeader" role="columnheader" aria-colindex="2" data-field="id" aria-sort="none" tabindex="-1">
            <div class="MuiDataGrid-columnHeaderDraggableContainer">
              <div class="MuiDataGrid-columnHeaderTitleContainer">
                <div class="MuiDataGrid-columnHeaderTitleContainerContent"><div class="MuiDataGrid-columnHeaderTitle">Order</div></div>
                <div class="MuiDataGrid-iconButtonContainer"><button type="button" aria-label="Sort" title="Sort">↑</button></div>
              </div>
            </div>
            <div class="MuiDataGrid-columnSeparator" aria-hidden="true">|</div>
          </div>
          <div class="MuiDataGrid-columnHeader" role="columnheader" aria-colindex="3" data-field="customer" tabindex="-1">
            <div class="MuiDataGrid-columnHeaderTitle">Customer</div><div class="MuiDataGrid-columnSeparator" aria-hidden="true">|</div>
          </div>
          <div class="MuiDataGrid-columnHeader" role="columnheader" aria-colindex="4" data-field="total" tabindex="-1">
            <div class="MuiDataGrid-columnHeaderTitle">Total</div>
          </div>
        </div>
      </div>
      <div class="MuiDataGrid-virtualScroller">
        <div class="MuiDataGrid-virtualScrollerContent">
          <div class="MuiDataGrid-virtualScrollerRenderZone" role="rowgroup">
            <div class="MuiDataGrid-row" role="row" data-id="1" data-rowindex="0" aria-rowindex="2" aria-selected="false">
              <div class="MuiDataGrid-cell MuiDataGrid-cellCheckbox" role="cell" data-field="__check__" aria-colindex="1" tabindex="-1"><span class="MuiCheckbox-root"><input type="checkbox" aria-label="Select row"></span></div>
              <div class="MuiDataGrid-cell" role="cell" data-field="id" aria-colindex="2" tabindex="-1"><div class="MuiDataGrid-cellContent" title="#1001">#1001</div></div>
              <div class="MuiDataGrid-cell" role="cell" data-field="customer" aria-colindex="3" tabindex="-1" id="olena"><a href="/customers/7?utm_source=grid">Olena K.</a></div>
              <div class="MuiDataGrid-cell" role="cell" data-field="total" aria-colindex="4" tabindex="-1">$120.00</div>
              <div class="MuiDataGrid-cell MuiDataGrid-cellEmpty"></div>
            </div>
            <div class="MuiDataGrid-row" role="row" data-id="2" data-rowindex="1" aria-rowindex="3" aria-selected="false">
              <div class="MuiDataGrid-cell MuiDataGrid-cellCheckbox" role="cell" data-field="__check__" aria-colindex="1"><span class="MuiCheckbox-root"><input type="checkbox"></span></div>
              <div class="MuiDataGrid-cell" role="cell" data-field="id" aria-colindex="2"><div class="MuiDataGrid-cellContent">#1002</div></div>
              <div class="MuiDataGrid-cell" role="cell" data-field="customer" aria-colindex="3" id="marco">Marco R. <a href="/customers/9">profile</a></div>
              <div class="MuiDataGrid-cell" role="cell" data-field="total" aria-colindex="4">$89.50</div>
            </div>
            <div class="MuiDataGrid-row" role="row" data-id="3" data-rowindex="2" aria-rowindex="4" aria-selected="false">
              <div class="MuiDataGrid-cell MuiDataGrid-cellCheckbox" role="cell" data-field="__check__" aria-colindex="1"><span class="MuiCheckbox-root"><input type="checkbox"></span></div>
              <div class="MuiDataGrid-cell" role="cell" data-field="id" aria-colindex="2"><div class="MuiDataGrid-cellContent">#1003</div></div>
              <div class="MuiDataGrid-cell" role="cell" data-field="customer" aria-colindex="3"><a href="https://shop.example.com/customers/12">Aiko T.</a></div>
              <div class="MuiDataGrid-cell" role="cell" data-field="total" aria-colindex="4">$240.10</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="MuiDataGrid-footerContainer"><div class="MuiTablePagination-root"><p>1–3 of 3</p><button aria-label="Go to next page">›</button></div></div>
  </div>`;

/** A plain ARIA table built from divs and spans, with a hidden row and a row header. */
const divTable = `
  <div role="table" id="plans" aria-label="Plans">
    <div role="rowgroup"><div role="row"><span role="columnheader">Plan</span><span role="columnheader">Price</span></div></div>
    <div role="rowgroup">
      <div role="row"><span role="cell">Free</span><span role="cell">$0</span></div>
      <div role="row" style="display: none"><span role="cell">Hidden</span><span role="cell">x</span></div>
      <div role="row"><span role="rowheader">Pro</span><span role="cell">$12</span></div>
    </div>
  </div>`;

const styles = '<style>.ag-hidden { display: none; }</style>';

function read(element: Element) {
  const result = readTable(element);
  if (result.status !== 'ok') throw new Error(result.status);
  return result;
}

describe('ARIA grids', () => {
  it('lists AG Grid, MUI DataGrid and div tables next to real tables, with sizes and previews', () => {
    render(`${agGrid}${muiGrid}${divTable}<h2>Real</h2><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`, styles);
    const list = listTables(document);
    expect(list.total).toBe(4);
    const [ag, mui, plans, real] = list.tables;
    expect(ag).toMatchObject({ grid: true, title: 'Olympic winners', rows: 5, columns: 4, headerRows: 2, declaredRows: 1003 });
    expect(ag?.preview.slice(0, 3)).toEqual([
      ['', '', 'Medals', 'Medals'],
      ['Athlete', 'Country', 'Gold', 'Silver'],
      ['Michael Phelps', 'United States', '8', '0'],
    ]);
    expect(mui).toMatchObject({ grid: true, title: 'Orders', rows: 4, columns: 3, headerRows: 1 });
    expect(mui?.declaredRows).toBeUndefined();
    expect(mui?.preview[0]).toEqual(['Order', 'Customer', 'Total']);
    expect(plans).toMatchObject({ grid: true, title: 'Plans', rows: 3, columns: 2 });
    expect(real).toMatchObject({ grid: false, title: 'Real' });
  });

  it('reads AG Grid rows in aria-rowindex order, merging pinned and scrolling parts, skipping hidden cells and filter inputs', () => {
    render(agGrid, styles);
    const result = read($('#ag'));
    expect(result.title).toBe('Olympic winners');
    expect(result.data.headerRows).toBe(2);
    expect(toCsv(result.data)).toBe(
      [',,Medals,Medals', 'Athlete,Country,Gold,Silver', 'Michael Phelps,United States,8,0', 'Natalie Coughlin,United States,3,', 'Aleksey Nemov,Russia,2,1'].join('\n'),
    );
    expect(result.data.rowIndexes).toEqual([1, 2, 4, 5, 6]);
    expect(Object.keys(JSON.parse(formatTable(result.data, 'json', { csvDelimiter: ',' }).text)[0])).toEqual(['Athlete', 'Country', 'Medals / Gold', 'Medals / Silver']);
  });

  it('reads MUI DataGrid without its checkbox column, buttons and separators, and keeps single links', () => {
    render(muiGrid);
    const result = read($('#mui'));
    expect(result.title).toBe('Orders');
    expect(toCsv(result.data)).toBe('Order,Customer,Total\n#1001,Olena K.,$120.00\n#1002,Marco R. profile,$89.50\n#1003,Aiko T.,$240.10');
    // Only cells that are exactly one link keep it; tracking parameters are gone.
    expect(result.data.links?.map((row) => row[1])).toEqual(['', 'https://example.com/customers/7', '', 'https://shop.example.com/customers/12']);
    expect(formatTable(result.data, 'csv', { csvDelimiter: ',', keepLinks: true }).text.split('\n').slice(0, 2)).toEqual([
      'Order,Customer,Customer URL,Total',
      '#1001,Olena K.,https://example.com/customers/7,$120.00',
    ]);
  });

  it('keeps every column and the row indexes for row recording', () => {
    render(muiGrid);
    const data = readTableData($('#mui'), 'none');
    expect(data.width).toBe(4);
    expect(data.rows[1]).toEqual(['', '#1001', 'Olena K.', '$120.00']);
    expect(data.rowIndexes).toEqual([1, 2, 3, 4]);
  });

  it('reads div tables: hidden rows skipped, row headers are data', () => {
    render(divTable);
    expect(toCsv(read($('#plans')).data)).toBe('Plan,Price\nFree,$0\nPro,$12');
  });

  it('finds a listed grid again by position and header, even after it rendered other rows', () => {
    render(`${muiGrid}${agGrid}`, styles);
    const summary = listTables(document).tables[1]!;
    $('#ag .ag-center-cols-container').lastElementChild?.remove();
    expect(findTableAt(document, summary.index, summary.signature)).toBe($('#ag'));
    $('#ag .ag-header-container .ag-header-cell-text').textContent = 'Nation';
    expect(findTableAt(document, summary.index, summary.signature)).toBeNull();
  });

  it('finds the grid around a selection', () => {
    render(`${muiGrid}${divTable}`);
    selectContents($('#olena'));
    expect(findSelectedTable(document)).toBe($('#mui'));
  });
});

describe('the table under a right-click (no selection)', () => {
  it('uses the focused cell (grids focus cells on right-click), then the text caret', () => {
    render(`${agGrid}${muiGrid}<table id="t"><tr><td id="plain">plain</td><td>x</td></tr></table>`, styles);
    ($('#phelps') as HTMLElement).focus();
    expect(findTableAtPoint(document)).toBe($('#ag'));

    ($('#phelps') as HTMLElement).blur();
    const text = $('#plain').firstChild as Text;
    window.getSelection()?.collapse(text, 2);
    expect(findTableAtPoint(document)).toBe($('#t'));
  });

  it('falls back to the only table on the page, and says so when there is none', () => {
    render(`<p id="p">Intro</p>${divTable}`);
    window.getSelection()?.collapse($('#p').firstChild as Text, 1);
    expect(findTableAtPoint(document)).toBe($('#plans'));
    render(`<p id="p">Intro</p>${divTable}<table><tr><td>a</td><td>b</td></tr></table>`);
    window.getSelection()?.collapse($('#p').firstChild as Text, 1);
    expect(findTableAtPoint(document)).toEqual({ none: 'no-table' });
  });

  it('skips layout tables around the click', () => {
    render(`<table role="presentation"><tr><td><table id="data"><tr><td id="cell">1</td><td>2</td></tr></table></td><td>side</td></tr></table>`);
    window.getSelection()?.collapse($('#cell').firstChild as Text, 0);
    expect(findTableAtPoint(document)).toBe($('#data'));
  });
});

describe('<table> rows with aria-rowindex (virtualized tables)', () => {
  it('reports the index of every row', () => {
    render(`<table id="t" aria-rowcount="100"><thead><tr aria-rowindex="1"><th>N</th></tr></thead><tbody><tr aria-rowindex="41"><td>40</td></tr><tr aria-rowindex="42"><td>41</td></tr></tbody></table>`);
    expect(readTableData($('#t')).rowIndexes).toEqual([1, 41, 42]);
    expect(listTables(document).tables[0]?.declaredRows).toBe(100);
  });
});
