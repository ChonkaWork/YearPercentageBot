import { extractArticle } from '../core/article';
import { convertSelection, convertTable, type ClipboardPayload, type ClipFormat, type SelectionFormat, type TableFormat } from '../core/convert';
import type { PageMeta } from '../core/frontMatter';
import { buildQuote } from '../core/quote';
import type { Settings } from '../core/settings';
import type { SelectionSnapshot } from '../core/snapshot';
import { normalizePlainText } from '../core/text';
import { buildTextFragment } from '../core/textFragment';
import { toPlainText } from '../core/plainText';
import { readPageMeta } from './meta';
import { pageTextModel } from './pageText';
import { listTables, readSelectedTable, readTableAt, snapshotDocument, snapshotSelection } from './reader';
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

/**
 * Where a quote's link leads: `passage` scrolls to and highlights the quote (text fragment),
 * `ambiguous` and `page` open the page (the passage repeats identically, or is in a text
 * field / couldn't be located), `none` means the page has no web address to link to.
 */
export type DeepLink = 'passage' | 'ambiguous' | 'page' | 'none';

export interface ClipResult extends SelectionResult {
  /** Quotes only. */
  deepLink?: DeepLink;
  /** Articles only: false when no main content stood out and the cleaned page was used. */
  found?: boolean;
}

export type ClipSource = 'selection' | 'article';

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

export interface PageInfo {
  title: string;
  url: string;
}

const PREVIEW_CHARS = 600;
const EMPTY: ClipResult = { kind: 'empty', payload: { text: '' }, truncated: false };

/** The selection as a quote with a link to exactly this passage. */
function quoteSelection(settings: Settings): ClipResult {
  const snapshot = snapshotSelection(document);
  if (snapshot.kind === 'empty') return EMPTY;
  const content = {
    markdown: convertSelection(snapshot, 'markdown', settings).text,
    text: convertSelection(snapshot, 'text', settings).text,
    html: convertSelection(snapshot, 'html', settings).html,
  };
  let fragment: string | null = null;
  let deepLink: DeepLink = 'page';
  if (snapshot.kind === 'dom') {
    const selection = document.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const model = range ? pageTextModel(document, range) : null;
    const result = model ? buildTextFragment(model) : null;
    if (result?.status === 'ok') {
      fragment = result.fragment;
      deepLink = 'passage';
    } else if (result?.status === 'ambiguous') {
      deepLink = 'ambiguous';
    }
  }
  const quote = buildQuote(content, { title: document.title, url: location.href, fragment }, settings.quoteStyle);
  return { kind: snapshot.kind, payload: quote.payload, truncated: snapshot.truncated, deepLink: quote.link ? deepLink : 'none' };
}

/** The page's main content (see src/core/article.ts), converted like a selection. */
function convertArticle(format: SelectionFormat, settings: Settings): ClipResult {
  const page = snapshotDocument(document);
  const article = extractArticle(page.nodes);
  const snapshot: SelectionSnapshot = { kind: 'dom', nodes: article.nodes, truncated: page.truncated, url: location.href };
  return { kind: 'dom', payload: convertSelection(snapshot, format, settings), truncated: page.truncated, found: article.found };
}

const api = {
  convertSelection(format: SelectionFormat, settings: Settings): SelectionResult {
    const snapshot = snapshotSelection(document);
    return {
      kind: snapshot.kind,
      payload: convertSelection(snapshot, format, settings),
      truncated: snapshot.kind !== 'empty' && snapshot.truncated,
    };
  },

  /** "Copy as quote with link". */
  convertQuote: (settings: Settings): ClipResult => quoteSelection(settings),

  /** "Copy article as Markdown" (and the popup's Article tab in every format). */
  convertArticle,

  /** The popup: the selection or the article, in any format including the quote. */
  convertClip(source: ClipSource, format: ClipFormat, settings: Settings): ClipResult {
    if (source === 'article') return format === 'quote' ? EMPTY : convertArticle(format, settings);
    return format === 'quote' ? quoteSelection(settings) : api.convertSelection(format, settings);
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

  /** For "Copy page link as Markdown" and download file names. */
  pageInfo: (): PageInfo => ({ title: document.title, url: location.href }),

  /** Author, dates and more for front matter. */
  pageMeta: (): PageMeta => readPageMeta(document),

  toast: showToast,
};

export type PageApi = typeof api;

(globalThis as unknown as { __universalCopy: PageApi }).__universalCopy = api;
