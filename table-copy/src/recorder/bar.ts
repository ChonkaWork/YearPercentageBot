import basketIcon from 'bootstrap-icons/icons/basket.svg';
import checkIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import copyIcon from 'bootstrap-icons/icons/clipboard.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import spreadsheetIcon from 'bootstrap-icons/icons/file-earmark-spreadsheet.svg';
import stopIcon from 'bootstrap-icons/icons/stop-fill.svg';
import closeIcon from 'bootstrap-icons/icons/x-lg.svg';
import { createShadowHost } from '../page/shadow';
import { svgIcon } from '../ui/icons';

/**
 * The recording bar: a small panel pinned next to the table while its rows are recorded.
 * "Recording · 1,284 rows · Stop", then, once stopped, the export buttons. It never
 * scrolls or clicks anything on the page: the user scrolls the grid or pages through it.
 */

export const BAR_TAG = 'table-copy-recorder';

export type BarAction = 'stop' | 'copy-csv' | 'copy-tsv' | 'xlsx' | 'basket' | 'close';

export interface StoppedOptions {
  xlsx: boolean;
  basket: boolean;
  /** The recording stopped on its own because the table left the page. */
  gone?: boolean;
}

const formatCount = (value: number) => value.toLocaleString('en-US');

export class RecorderBar {
  private readonly host: HTMLElement;
  private readonly panel: HTMLDivElement;
  private readonly live: HTMLDivElement;
  private lastAnnounced = 0;

  constructor(private readonly onAction: (action: BarAction, button: HTMLButtonElement) => void) {
    for (const stale of Array.from(document.querySelectorAll(BAR_TAG))) stale.remove();
    const { host, root } = createShadowHost(BAR_TAG);
    this.host = host;
    this.panel = document.createElement('div');
    this.panel.className = 'tc-bar';
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', 'Table Copy: record rows');
    this.live = document.createElement('div');
    this.live.className = 'tc-sr';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    root.append(this.panel, this.live);
    document.documentElement.append(host);
  }

  /** Live counter. `total` is the row count the grid declares (aria-rowcount), if any. */
  showRecording(rows: number, total: number | null): void {
    const count = total && total >= rows ? `${formatCount(rows)} of ${formatCount(total)} rows` : `${formatCount(rows)} ${rows === 1 ? 'row' : 'rows'}`;
    const existing = this.panel.querySelector<HTMLElement>('.tc-count');
    if (existing && this.panel.dataset.state === 'recording') {
      existing.textContent = count;
    } else {
      this.panel.dataset.state = 'recording';
      const dot = element('span', 'tc-dot');
      dot.setAttribute('aria-hidden', 'true');
      this.panel.replaceChildren(
        dot,
        element('span', 'tc-label', 'Recording'),
        element('span', 'tc-count', count),
        element('span', 'tc-hint', 'Scroll the table or click its Next button'),
        this.button('stop', 'Stop', stopIcon, 'tc-btn tc-btn-primary'),
      );
    }
    // Screen readers hear the count now and then, not on every row.
    if (Date.now() - this.lastAnnounced > 5000) {
      this.lastAnnounced = Date.now();
      this.live.textContent = `Recording: ${count}.`;
    }
  }

  showStopped(rows: number, options: StoppedOptions): void {
    this.panel.dataset.state = 'stopped';
    const icon = svgIcon(options.gone ? errorIcon : checkIcon, 16);
    icon.classList.add(options.gone ? 'tc-icon-warn' : 'tc-icon-ok');
    const title = options.gone ? `The table left the page · ${formatCount(rows)} rows kept` : `Recorded ${formatCount(rows)} ${rows === 1 ? 'row' : 'rows'}`;
    const parts: Node[] = [icon, element('span', 'tc-label', title), this.button('copy-csv', 'Copy CSV', copyIcon), this.button('copy-tsv', 'Copy TSV', copyIcon)];
    if (options.xlsx) parts.push(this.button('xlsx', 'Download .xlsx', spreadsheetIcon));
    if (options.basket) parts.push(this.button('basket', 'Add to basket', basketIcon));
    parts.push(this.button('close', '', closeIcon, 'tc-btn tc-btn-icon', 'Close. The rows stay in the Table Copy popup.'));
    this.panel.replaceChildren(...parts);
    this.live.textContent = `${title}. Copy or download them from this bar or from the Table Copy popup.`;
    this.panel.querySelector<HTMLButtonElement>('[data-action="copy-csv"]')?.focus({ preventScroll: true });
  }

  /** Inline result on the button that was pressed ("Copied"), restored after a moment. */
  flash(button: HTMLButtonElement, label: string, ok = true): void {
    const original = Array.from(button.childNodes);
    button.replaceChildren(svgIcon(ok ? checkIcon : errorIcon, 14), label);
    button.classList.toggle('tc-done', ok);
    button.classList.toggle('tc-failed', !ok);
    this.live.textContent = label;
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.replaceChildren(...original);
      button.classList.remove('tc-done', 'tc-failed');
    }, 1800);
  }

  /** Keeps the bar just above the table, inside the viewport. */
  place(rect: DOMRect | null): void {
    const width = this.panel.offsetWidth;
    const height = this.panel.offsetHeight;
    const margin = 8;
    const anchorTop = rect ? rect.top - height - 10 : margin;
    const anchorLeft = rect ? rect.left : (window.innerWidth - width) / 2;
    const top = Math.min(Math.max(margin, anchorTop), Math.max(margin, window.innerHeight - height - margin));
    const left = Math.min(Math.max(margin, anchorLeft), Math.max(margin, window.innerWidth - width - margin));
    this.panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  remove(): void {
    this.host.remove();
  }

  get connected(): boolean {
    return this.host.isConnected;
  }

  private button(action: BarAction, label: string, icon: string, className = 'tc-btn', ariaLabel?: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.action = action;
    button.append(svgIcon(icon, 14));
    if (label) button.append(label);
    if (ariaLabel) {
      button.setAttribute('aria-label', ariaLabel);
      button.title = ariaLabel;
    }
    button.addEventListener('click', () => this.onAction(action, button));
    return button;
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
