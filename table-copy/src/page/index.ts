import { findSelectedTable, findTableAt, listTables, overlappingTables, readTable, type TableRead } from './reader';
import { showToast } from './toast';

/**
 * Entry point of page.js, injected on demand with chrome.scripting.executeScript (no
 * always-on content scripts). It only defines functions in the extension's isolated
 * world; the background and the popup call them with a second executeScript. Injecting
 * again (e.g. after an extension update) simply replaces them.
 *
 * The page turns a table into a plain grid of cell texts (TableData); every format,
 * column pick and merge happens in the extension from that grid.
 */

const api = {
  listTables: () => listTables(document),

  /** A table listed by listTables(), unless the page changed since. */
  readTableAt(index: number, signature: string): TableRead {
    const table = findTableAt(document, index, signature);
    return table ? readTable(table, 1) : { status: 'changed' };
  },

  /** "Copy table as": the table around (or overlapping) the selection. */
  readSelectedTable(): TableRead {
    const found = findSelectedTable(document);
    if ('none' in found) return { status: found.none };
    return readTable(found, overlappingTables(document));
  },

  toast: showToast,
};

export type PageApi = typeof api;
export type { PageInfo, TableRead } from './reader';

(globalThis as unknown as { __tableCopy: PageApi }).__tableCopy = api;
