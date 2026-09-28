import { POPUP_PORT } from '../platform/messages';
import { outline, removeOutlines, scrollToTable } from './overlay';
import { findSelectedTable, findTableAt, findTableAtPoint, listTables, overlappingTables, readTable, type TableRead } from './reader';
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

  /** "Copy table as" after a right-click without a selection: the table under the click. */
  readTableAtPoint(): TableRead {
    const found = findTableAtPoint(document);
    if ('none' in found) return { status: found.none };
    return readTable(found, 1);
  },

  /** Outlines a listed table (popup hover/focus) and scrolls it into view; -1 removes it. */
  highlight(index: number, signature: string): boolean {
    const table = index >= 0 ? findTableAt(document, index, signature) : null;
    if (!table) {
      removeOutlines('hover');
      return false;
    }
    outline(table, 'hover');
    scrollToTable(table);
    return true;
  },

  toast: showToast,
};

export type PageApi = typeof api;
export type { PageInfo, TableRead } from './reader';

const scope = globalThis as unknown as { __tableCopy: PageApi; __tableCopyPort?: boolean };
scope.__tableCopy = api;

// One listener per page, however often the script is injected.
if (!scope.__tableCopyPort) {
  scope.__tableCopyPort = true;
  chrome.runtime.onConnect.addListener((port) => {
    // The popup connects while it's open; when it closes, its outline goes.
    if (port.name === POPUP_PORT) port.onDisconnect.addListener(() => removeOutlines('hover'));
  });
}
