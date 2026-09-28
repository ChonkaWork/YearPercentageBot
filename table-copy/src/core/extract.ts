import { singleLinkUrl } from './links';
import { normalizeTree } from './normalize';
import { plainCellText } from './plainText';
import { isElement, type SnapElement } from './snapshot';
import { buildTableModel, extractTableData, type ExtractOptions, type TableData } from './table';

/**
 * A table snapshot (read from the page) as a rectangular grid of cell texts. Spanning
 * cells repeat their value in every slot they cover: what spreadsheets and data tools
 * expect. This grid is what every export works on. Cells that are a single link also
 * report its URL (`links`), for "Keep links".
 */
export function tableDataFromSnapshot(table: SnapElement, dropEmptyColumns: ExtractOptions['dropEmptyColumns'] = 'trailing'): TableData {
  const [normalized] = normalizeTree([table]);
  if (!isElement(normalized)) return emptyTable();
  return extractTableData(buildTableModel(normalized), (cell) => plainCellText(cell), 'repeat', { link: singleLinkUrl, dropEmptyColumns });
}

export function emptyTable(): TableData {
  return { rows: [], headerRows: 0, width: 0, truncated: false };
}

/** Number of body (non-header) rows. */
export function bodyRowCount(data: TableData): number {
  return Math.max(0, data.rows.length - data.headerRows);
}
