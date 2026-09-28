import { isElement, type SnapElement, type SnapNode } from './snapshot';
import { combineHeaderRows, type TableData } from './table';

/**
 * "Keep links": a cell whose whole content is one link keeps its URL. CSV, TSV, JSON and
 * .xlsx get an extra "<Column> URL" column right after each column that has links;
 * Markdown writes the cell as [text](url). Only absolute http(s) URLs are kept (the page
 * reader already resolved them and removed tracking parameters).
 */

/** The URL when the cell's content is exactly one http(s) link (and nothing else), else ''. */
export function singleLinkUrl(cell: SnapElement): string {
  let href = '';
  let links = 0;
  let outside = false;
  const walk = (node: SnapNode, inLink: boolean) => {
    if (!isElement(node)) {
      if (!inLink && node.v.trim() !== '') outside = true;
      return;
    }
    if (node.tag === 'a' && node.a?.href) {
      links++;
      href = node.a.href;
      for (const child of node.c) walk(child, true);
      return;
    }
    // An image outside the link is content of its own (a flag next to a country name).
    if (!inLink && node.tag === 'img') outside = true;
    for (const child of node.c) walk(child, inLink);
  };
  for (const child of cell.c) walk(child, false);
  if (links !== 1 || outside || !/^https?:\/\//i.test(href)) return '';
  return href;
}

/** Columns that have a link in at least one body row. */
export function linkColumns(data: TableData): number[] {
  const links = data.links;
  if (!links) return [];
  const columns: number[] = [];
  for (let column = 0; column < data.width; column++) {
    for (let row = data.headerRows; row < links.length; row++) {
      if (links[row]?.[column]) {
        columns.push(column);
        break;
      }
    }
  }
  return columns;
}

/**
 * The table with a "<Column> URL" column after every column that has links. With several
 * header rows, the name goes in the last one (so the combined label reads
 * "Population / 2010 URL") and the others stay empty.
 */
export function expandLinks(data: TableData): TableData {
  const columns = new Set(linkColumns(data));
  const { links, ...rest } = data;
  if (!links || columns.size === 0) return rest;
  const labels = data.headerRows > 0 ? combineHeaderRows(data) : [];
  const rows = data.rows.map((row, y) => {
    const out: string[] = [];
    for (let x = 0; x < data.width; x++) {
      out.push(row[x] ?? '');
      if (!columns.has(x)) continue;
      if (y < data.headerRows) out.push(y === data.headerRows - 1 ? `${labels[x] || `Column ${x + 1}`} URL` : '');
      else out.push(links[y]?.[x] ?? '');
    }
    return out;
  });
  return { ...rest, rows, width: data.width + columns.size };
}

/** The table without link information: what every export uses when "Keep links" is off. */
export function withoutLinks(data: TableData): TableData {
  if (!data.links) return data;
  const { links: _links, ...rest } = data;
  return rest;
}

/** A Markdown link destination: parentheses, spaces and angle brackets percent-encoded. */
export function markdownUrl(url: string): string {
  return url.replace(/[()<>\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}
