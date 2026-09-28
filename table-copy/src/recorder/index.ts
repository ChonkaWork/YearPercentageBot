import { basketItemFrom } from '../core/basket';
import { fileName, formatTable, type CsvDelimiter } from '../core/formats';
import { positiveInt } from '../core/grid';
import { expandLinks, withoutLinks } from '../core/links';
import { captureFrom, mergeCapture, recordedRowCount, recordingToTable, startRecording, storableTable, type Recording, type StoredRecording } from '../core/recording';
import type { TableData } from '../core/table';
import { buildXlsx, XLSX_MIME } from '../core/xlsx';
import { outline, removeOutlines, type Outline } from '../page/overlay';
import { findTableAt, headerSignature, pageInfo, readTableData, tableElements, type PageInfo } from '../page/reader';
import type { CopyRequest } from '../platform/messages';
import { limitsFor } from '../core/plan';
import { addBasketItem, loadPlan, newItemId, saveRecording } from '../storage/store';
import { downloadBytes } from '../ui/download';
import { basketFailure } from '../ui/format';
import { RecorderBar, type BarAction } from './bar';

/**
 * Entry point of recorder.js, injected on demand when the user starts "Record rows" in
 * the popup (activeTab + scripting, like page.js). It watches one table: whenever its
 * rows change (a MutationObserver) or it scrolls, it reads the rows currently in the DOM
 * and merges them into the recording (src/core/recording.ts). It never scrolls or clicks
 * anything itself: the user scrolls the grid or clicks the site's own Next button.
 *
 * The recording is kept in chrome.storage.local as it grows, so the popup can export it
 * even if the page navigates away (which ends this script along with the page).
 */

export interface RecordOptions {
  tabId: number;
  /** The table's name in the popup. */
  title: string;
  csvDelimiter: CsvDelimiter;
  keepLinks: boolean;
  xlsxNumbers: boolean;
  /** What the plan allows from the bar. */
  xlsx: boolean;
  basket: boolean;
}

export type StartResult = { status: 'ok'; id: string; rows: number } | { status: 'changed' };

export interface LiveStatus {
  id: string;
  state: 'recording' | 'stopped';
  rows: number;
}

/** How long the table may be missing from the page before the recording stops by itself. */
const GONE_AFTER_MS = 3000;
const PERSIST_DELAY_MS = 700;

class Session {
  readonly id = newItemId();
  private state: 'recording' | 'stopped' = 'recording';
  private ended: StoredRecording['ended'];
  private readonly recording: Recording;
  private readonly header: string;
  private readonly page: PageInfo;
  private readonly total: number | null;
  private readonly startedAt = Date.now();
  private readonly observer: MutationObserver;
  private readonly bar: RecorderBar;
  private readonly outline: Outline;
  private timer = 0;
  private persistTimer = 0;
  private readonly watchdog: number;
  private lastDuration = 0;
  private lastCapture = 0;
  private goneSince = 0;

  constructor(
    private element: Element,
    private readonly index: number,
    private readonly options: RecordOptions,
  ) {
    this.header = headerSignature(element);
    this.page = pageInfo(document);
    this.recording = startRecording(captureFrom(readTableData(element, 'none')));
    this.total = declaredBodyRows(element);
    this.bar = new RecorderBar((action, button) => void this.act(action, button));
    this.outline = outline(element, 'recording', (rect) => this.bar.place(rect));
    this.observer = new MutationObserver(() => this.schedule());
    this.observe();
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    window.addEventListener('pagehide', this.onPageHide);
    this.watchdog = window.setInterval(() => this.checkElement(), 500);
    this.render();
    this.persist();
  }

  get rows(): number {
    return recordedRowCount(this.recording);
  }

  status(): LiveStatus {
    return { id: this.id, state: this.state, rows: this.rows };
  }

  stop(reason?: StoredRecording['ended']): void {
    if (this.state === 'stopped') return;
    window.clearTimeout(this.timer);
    if (this.element.isConnected) this.capture();
    this.state = 'stopped';
    this.ended = reason;
    this.detach();
    this.outline.remove();
    this.bar.showStopped(this.rows, { xlsx: this.options.xlsx, basket: this.options.basket, gone: reason === 'table-gone' });
    this.persist();
  }

  /** Replaced by a new recording: no trace left on the page. */
  dispose(): void {
    this.detach();
    this.outline.remove();
    this.bar.remove();
  }

  private detach(): void {
    window.clearTimeout(this.timer);
    window.clearInterval(this.watchdog);
    this.observer.disconnect();
    document.removeEventListener('scroll', this.onScroll, { capture: true });
  }

  private observe(): void {
    this.observer.observe(this.element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-rowindex', 'aria-hidden', 'hidden', 'style', 'class'],
    });
  }

  private readonly onScroll = (event: Event) => {
    const target = event.target;
    if (target === document || (target instanceof Node && (target.contains(this.element) || this.element.contains(target)))) this.schedule(false);
  };

  private readonly onPageHide = () => {
    // The page is going away and this script with it: save what we have.
    if (this.state === 'recording') this.persist();
  };

  /**
   * Captures as soon as the table's DOM changes (a virtualized grid may replace its rows
   * again on the next scroll), then at most every 50 ms while it keeps changing; less often
   * when captures are expensive (huge tables). A scroll only schedules a later capture: the
   * grid renders its new rows after the scroll event.
   */
  private schedule(leading = true): void {
    if (this.state !== 'recording' || this.timer) return;
    const gap = Math.max(50, Math.min(2000, this.lastDuration * 3));
    const wait = leading ? this.lastCapture + gap - performance.now() : gap;
    if (wait <= 0) {
      this.capture();
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.capture();
    }, wait);
  }

  private capture(): void {
    if (!this.element.isConnected) return;
    const started = performance.now();
    this.lastCapture = started;
    const added = mergeCapture(this.recording, captureFrom(readTableData(this.element, 'none')));
    this.lastDuration = performance.now() - started;
    if (added > 0) {
      this.render();
      this.schedulePersist();
    }
  }

  private render(): void {
    this.bar.showRecording(this.rows, this.total);
    this.outline.move();
  }

  /** AJAX pages sometimes replace the whole table: follow the new one (same header). */
  private checkElement(): void {
    if (this.state !== 'recording') return;
    if (this.element.isConnected) {
      this.goneSince = 0;
      return;
    }
    const tables = tableElements(document);
    const candidates = [tables[this.index], ...tables].filter((table): table is Element => table !== undefined);
    const replacement = candidates.find((table) => headerSignature(table) === this.header);
    if (replacement) {
      this.element = replacement;
      this.observer.disconnect();
      this.observe();
      this.outline.retarget(replacement);
      this.goneSince = 0;
      this.schedule();
      return;
    }
    this.goneSince ||= Date.now();
    if (Date.now() - this.goneSince > GONE_AFTER_MS) this.stop('table-gone');
  }

  private table(): TableData {
    const table = recordingToTable(this.recording);
    return this.options.keepLinks ? table : withoutLinks(table);
  }

  private schedulePersist(): void {
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persist(), PERSIST_DELAY_MS);
  }

  private persist(): void {
    window.clearTimeout(this.persistTimer);
    const { table, partial } = storableTable(recordingToTable(this.recording));
    const record: StoredRecording = {
      id: this.id,
      tabId: this.options.tabId,
      title: this.options.title,
      pageTitle: this.page.pageTitle,
      url: this.page.url,
      decimal: this.page.decimal,
      state: this.state,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      rowCount: this.rows,
      table,
      partial,
    };
    if (this.ended) record.ended = this.ended;
    saveRecording(record).catch(() => undefined);
  }

  private async act(action: BarAction, button: HTMLButtonElement): Promise<void> {
    switch (action) {
      case 'stop':
        this.stop();
        return;
      case 'copy-csv':
      case 'copy-tsv': {
        const format = action === 'copy-csv' ? 'csv' : 'tsv';
        const payload = formatTable(this.table(), format, this.options);
        const ok = await copyInBackground(payload);
        this.bar.flash(button, ok ? 'Copied' : "Couldn't copy", ok);
        return;
      }
      case 'xlsx': {
        const table = this.options.keepLinks ? expandLinks(this.table()) : this.table();
        const bytes = buildXlsx([{ name: this.options.title || 'Recorded rows', rows: table.rows, headerRows: table.headerRows }], {
          numbers: this.options.xlsxNumbers,
          decimal: this.page.decimal,
        });
        downloadBytes(bytes, fileName(this.options.title || this.page.pageTitle, 'xlsx'), XLSX_MIME);
        this.bar.flash(button, 'Saved');
        return;
      }
      case 'basket': {
        const table = this.options.keepLinks ? expandLinks(this.table()) : this.table();
        const item = basketItemFrom(table, { title: this.options.title, pageTitle: this.page.pageTitle, url: this.page.url, decimal: this.page.decimal }, newItemId(), Date.now());
        try {
          const result = await addBasketItem(item);
          const limit = limitsFor(await loadPlan()).basketTables;
          this.bar.flash(button, result.ok ? 'Added' : basketFailure(result.reason, limit).title, result.ok);
        } catch {
          this.bar.flash(button, "Couldn't save", false);
        }
        return;
      }
      case 'close':
        this.bar.remove();
        return;
    }
  }
}

/** Rows the grid says it has (aria-rowcount) minus its header rows; null when it doesn't say. */
function declaredBodyRows(element: Element): number | null {
  const declared = positiveInt(element.getAttribute('aria-rowcount'));
  if (declared === undefined) return null;
  const headers = new Set<string>();
  for (const row of Array.from(element.querySelectorAll('[role="row"], thead tr'))) {
    if (row.matches('thead tr') || row.querySelector('[role="columnheader"]')) headers.add(row.getAttribute('aria-rowindex') ?? `h${headers.size}`);
  }
  return Math.max(0, declared - headers.size);
}

/** The offscreen document writes the clipboard: no user gesture or page focus needed. */
async function copyInBackground(payload: CopyRequest['payload']): Promise<boolean> {
  if (!payload.text) return false;
  try {
    const request: CopyRequest = { type: 'tc/copy', payload };
    const response = (await chrome.runtime.sendMessage(request)) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch {
    return false;
  }
}

// The session lives on the isolated world's global, so a popup that injects this script
// again (every popup injects once) still finds a recording started earlier.
const scope = globalThis as unknown as { __tableCopyRecorder: RecorderApi; __tableCopySession?: Session | null };

const api = {
  start(index: number, signature: string, options: RecordOptions): StartResult {
    const table = findTableAt(document, index, signature);
    if (!table) return { status: 'changed' };
    scope.__tableCopySession?.dispose();
    // The popup's hover outline gives way to the recording's own.
    removeOutlines('hover');
    const session = new Session(table, index, options);
    scope.__tableCopySession = session;
    return { status: 'ok', id: session.id, rows: session.rows };
  },

  status(): LiveStatus | null {
    return scope.__tableCopySession?.status() ?? null;
  },

  stop(): LiveStatus | null {
    const session = scope.__tableCopySession;
    session?.stop();
    return session?.status() ?? null;
  },
};

export type RecorderApi = typeof api;

scope.__tableCopyRecorder = api;
