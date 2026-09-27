// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { convertSelection, convertTable } from '../src/core/convert';
import { defaultSettings } from '../src/core/settings';
import type { SelectionSnapshot } from '../src/core/snapshot';
import { listTables, readSelectedTable, readTableAt, snapshotSelection } from '../src/page/reader';
import { $, render, selectContents, selectRange, textIn } from './helpers';

const settings = defaultSettings('en-US');
const asMarkdown = (snapshot: SelectionSnapshot) => convertSelection(snapshot, 'markdown', settings).text;
const asText = (snapshot: SelectionSnapshot) => convertSelection(snapshot, 'text', settings).text;

describe('snapshotSelection', () => {
  it('reports an empty selection', () => {
    render('<p>Hello</p>');
    window.getSelection()?.removeAllRanges();
    expect(snapshotSelection(document).kind).toBe('empty');
  });

  it('cuts text nodes at the selection boundaries', () => {
    render('<p id="p">Hello brave new world</p>');
    selectRange(textIn('#p'), 6, textIn('#p'), 15);
    expect(asText(snapshotSelection(document))).toBe('brave new');
  });

  it('keeps the link, emphasis and code around a partial selection', () => {
    render('<p>See <a id="a" href="/docs/x"><b>the full docs</b></a> and <code id="c">npm run build</code></p>');
    selectRange(textIn('#a'), 4, textIn('#a'), 8);
    expect(asMarkdown(snapshotSelection(document))).toBe('[**full**](https://example.com/docs/x)');
    selectRange(textIn('#c'), 4, textIn('#c'), 13);
    expect(asMarkdown(snapshotSelection(document))).toBe('`run build`');
  });

  it('keeps a code block (with its language) when only some lines are selected', () => {
    render('<pre id="pre"><code class="language-py">a = 1\nb = 2\nc = 3</code></pre>');
    selectRange(textIn('#pre'), 6, textIn('#pre'), 11);
    expect(asMarkdown(snapshotSelection(document))).toBe('```py\nb = 2\n```');
  });

  it('keeps list structure when several items are selected', () => {
    render('<ol start="3" id="list"><li id="one">First item</li><li>Second</li><li id="three">Third item</li></ol>');
    selectRange(textIn('#one'), 6, textIn('#three'), 5);
    expect(asMarkdown(snapshotSelection(document))).toBe('3. item\n4. Second\n5. Third');
  });

  it('turns a fully selected heading or list item into one, a partial one into text', () => {
    render('<h2 id="h">Release notes</h2><ul><li id="li">Only item</li></ul>');
    selectContents($('#h'));
    expect(asMarkdown(snapshotSelection(document))).toBe('## Release notes');
    selectRange(textIn('#h'), 0, textIn('#h'), 7);
    expect(asMarkdown(snapshotSelection(document))).toBe('Release');
    selectContents($('#li'));
    expect(asMarkdown(snapshotSelection(document))).toBe('- Only item');
  });

  it('builds a table from selected rows, but plain text from inside one cell', () => {
    render('<table><tr><th>Name</th><th>Age</th></tr><tr id="r"><td id="c">Ann Lee</td><td>31</td></tr></table>');
    selectRange(textIn('th'), 0, textIn('#r td:last-child'), 2);
    expect(asMarkdown(snapshotSelection(document))).toBe('| Name    | Age |\n| ------- | --- |\n| Ann Lee | 31  |');
    selectRange(textIn('#c'), 0, textIn('#c'), 3);
    expect(asMarkdown(snapshotSelection(document))).toBe('Ann');
  });

  it('reads selections inside text fields as plain text, never password fields', () => {
    render('<textarea id="t">line one\nline two</textarea><input id="pw" type="password" value="secret">');
    const field = $('#t') as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(5, 17);
    expect(snapshotSelection(document)).toMatchObject({ kind: 'plain', text: 'one\nline two' });
    const password = $('#pw') as HTMLInputElement;
    password.focus();
    password.setSelectionRange(0, 6);
    expect(snapshotSelection(document).kind).not.toBe('plain');
  });

  it('keeps aria-hidden containers that hold the selection (apps hidden behind a dialog)', () => {
    render('<div id="app" aria-hidden="true"><p id="p">Visible article text</p></div>');
    selectContents($('#p'));
    expect(asText(snapshotSelection(document))).toBe('Visible article text');
  });

  it('stops at the size limit and says so', () => {
    render('<p id="p">abcdefghij</p><p>klmnop</p>');
    selectContents(document.body);
    const snapshot = snapshotSelection(document, { maxChars: 4, maxElements: 100 });
    expect(snapshot).toMatchObject({ kind: 'dom', truncated: true });
    expect(asText(snapshot)).toBe('abcd');
  });
});

describe('tables', () => {
  const page = `
    <h2>Prices</h2>
    <table id="t1"><caption>Plans</caption><tr><th>Plan</th><th>Price</th></tr><tr><td>Free</td><td>$0</td></tr></table>
    <div style="display:none"><table id="hidden"><tr><td>a</td><td>b</td></tr></table></div>
    <table role="presentation" id="layout"><tr><td>x</td><td>y</td></tr></table>
    <h3>Population</h3>
    <table id="t2">
      <thead><tr><th rowspan="2">City</th><th colspan="2">Population</th></tr><tr><th>2010</th><th>2020</th></tr></thead>
      <tbody><tr><td id="kyiv">Kyiv</td><td>2.8M</td><td>2.9M</td></tr><tr><td>Lviv</td><td>0.7M</td><td>0.7M</td></tr>
      <tr><td>Nested</td><td colspan="2"><table id="inner"><tr><td id="in1">i1</td><td>i2</td></tr></table></td></tr></tbody>
    </table>
    <p id="outside">Not a table</p>`;

  it('lists visible data tables with size, title and preview', () => {
    render(page);
    const list = listTables(document);
    expect(list.total).toBe(3);
    const [first, second, inner] = list.tables;
    expect(first).toMatchObject({ title: 'Plans', rows: 2, columns: 2, headerRows: 1, preview: [['Plan', 'Price'], ['Free', '$0']] });
    expect(second).toMatchObject({ title: 'Population', rows: 5, columns: 3, headerRows: 2 });
    expect(second?.preview[0]).toEqual(['City', 'Population', 'Population']);
    expect(inner).toMatchObject({ rows: 1, columns: 2 });
  });

  it('reads a listed table again, and notices when the page changed', () => {
    render(page);
    const summary = listTables(document).tables[1]!;
    const read = readTableAt(document, summary.index, summary.signature);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(convertTable(read.table, 'csv', settings).payload.text).toBe(
      'City,Population,Population\nCity,2010,2020\nKyiv,2.8M,2.9M\nLviv,0.7M,0.7M\nNested,i1 i2,i1 i2',
    );
    $('#kyiv').closest('tr')?.remove();
    $('#t2 thead tr th').textContent = 'Town';
    expect(readTableAt(document, summary.index, summary.signature).status).toBe('changed');
  });

  it('finds the table around the selection (innermost first) or overlapping it', () => {
    render(page);
    selectContents($('#kyiv'));
    expect(readSelectedTable(document)).toMatchObject({ status: 'ok', title: 'Population', overlapping: 1 });
    selectContents($('#in1'));
    const inner = readSelectedTable(document);
    expect(inner.status === 'ok' && convertTable(inner.table, 'csv', settings).payload.text).toBe('i1,i2');
    selectRange(textIn('h2'), 0, textIn('#kyiv'), 2);
    expect(readSelectedTable(document)).toMatchObject({ status: 'ok', title: 'Plans', overlapping: 2 });
    selectContents($('#outside'));
    expect(readSelectedTable(document)).toEqual({ status: 'no-table' });
    window.getSelection()?.removeAllRanges();
    expect(readSelectedTable(document)).toEqual({ status: 'no-selection' });
  });

  it('skips hidden rows and hidden sort keys', () => {
    render('<table id="t"><tr><th>Name</th><th>Rank</th></tr><tr><td>A</td><td><span style="display:none">0001</span>1</td></tr><tr style="display:none"><td>B</td><td>2</td></tr></table>');
    selectContents($('td'));
    const found = readSelectedTable(document);
    expect(found.status === 'ok' && convertTable(found.table, 'tsv', settings).payload.text).toBe('Name\tRank\nA\t1');
  });
});
