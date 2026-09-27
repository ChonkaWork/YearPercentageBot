import { convertSelection, convertTable, type ClipboardPayload, type SelectionFormat, type TableFormat } from '../core/convert';
import type { Settings } from '../core/settings';
import { normalizePlainText } from '../core/text';
import { toPlainText } from '../core/plainText';
import { listTables, readSelectedTable, readTableAt, snapshotSelection } from './reader';
import { showToast } from './toast';

/**
 * Entry point of page.js, injected on demand with chrome.scripting.executeScript (no
 * always-on content scripts). It only defines functions in the extension's isolated
 * world; the background and the popup call them with a second executeScript. Injecting
 * again (e.g. after an extension update) simply replaces them.
 *
 * Conversion happens here, next to the DOM: only the result (usually far smaller than a
 * snapshot of a big table) crosses back to the extension.
 */

export interface SelectionResult {
  kind: 'dom' | 'plain' | 'empty';
  payload: ClipboardPayload;
  truncated: boolean;
}

export interface SelectionPreview {
  kind: 'dom' | 'plain' | 'empty';
  /** Start of the clean text, for display. */
  text: string;
  /** Length of the whole clean text. */
  length: number;
  truncated: boolean;
}

export type TableResult =
  | { status: 'ok'; payload: ClipboardPayload; rows: number; columns: number; truncated: boolean; overlapping: number; title: string }
  | { status: 'no-selection' | 'no-table' | 'changed' };

const PREVIEW_CHARS = 600;

const api = {
  convertSelection(format: SelectionFormat, settings: Settings): SelectionResult {
    const snapshot = snapshotSelection(document);
    return {
      kind: snapshot.kind,
      payload: convertSelection(snapshot, format, settings),
      truncated: snapshot.kind !== 'empty' && snapshot.truncated,
    };
  },

  previewSelection(): SelectionPreview {
    const snapshot = snapshotSelection(document);
    if (snapshot.kind === 'empty') return { kind: 'empty', text: '', length: 0, truncated: false };
    const text = snapshot.kind === 'plain' ? normalizePlainText(snapshot.text) : toPlainText(snapshot.nodes, { pageUrl: snapshot.url });
    return { kind: snapshot.kind, text: text.slice(0, PREVIEW_CHARS), length: text.length, truncated: snapshot.truncated };
  },

  /** "Copy table as": the table around (or overlapping) the selection. */
  convertSelectedTable(format: TableFormat, settings: Settings): TableResult {
    const found = readSelectedTable(document);
    if (found.status !== 'ok') return { status: found.status };
    const result = convertTable(found.table, format, settings);
    return { status: 'ok', ...result, truncated: result.truncated || found.truncated, overlapping: found.overlapping, title: found.title };
  },

  listTables: () => listTables(document),

  /** A table listed by listTables(), unless the page changed since. */
  convertTableAt(index: number, signature: string, format: TableFormat, settings: Settings): TableResult {
    const found = readTableAt(document, index, signature);
    if (found.status !== 'ok') return { status: found.status };
    const result = convertTable(found.table, format, settings);
    return { status: 'ok', ...result, truncated: result.truncated || found.truncated, overlapping: 1, title: found.title };
  },

  toast: showToast,
};

export type PageApi = typeof api;

(globalThis as unknown as { __universalCopy: PageApi }).__universalCopy = api;
