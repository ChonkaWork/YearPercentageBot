import { sortCountdowns, countdownState, type Countdown } from '../core/countdown';
import { describeLife } from '../core/life';
import { countdownDecimals, decimalsFor, type Settings } from '../core/settings';
import {
  SHARE_BLOCKS,
  SHARE_HEIGHT,
  SHARE_WIDTH,
  countdownCard,
  lifeCard,
  monthCard,
  shareCardText,
  yearCard,
  type ShareCard,
  type ShareKind,
} from '../core/share';
import { byId, errorMessage, h, setAttr, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { proBadge } from './settings-panel';

/** What the dialog needs from the page when it opens or an option changes. */
export interface ShareContext {
  now: Date;
  /** The settings as shown (Pro choices the plan lacks already removed). */
  settings: Settings;
  countdowns: readonly Countdown[];
  hour12: boolean;
  /** Whether the plan includes Life in weeks. */
  lifeEntitled: boolean;
}

const KIND_LABELS: Record<ShareKind, string> = { year: 'Year', month: 'Month', life: 'Life in weeks', countdown: 'Countdown' };

const FONT_SANS = '"Manrope Variable", system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono Variable", ui-monospace, monospace';
const BRAND = '#0ca678';

interface Palette {
  page: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  track: string;
}

/** The page's current theme, read from the same custom properties the page is styled with. */
function currentPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    page: read('--pt-page-bg', '#f4f7f6'),
    surface: read('--pt-surface', '#ffffff'),
    border: read('--bs-border-color', '#dde5e1'),
    text: read('--bs-body-color', '#17201d'),
    muted: read('--bs-secondary-color', '#5c6b66'),
    accent: read('--pt-accent', BRAND),
    accentText: read('--pt-accent-text', '#087f5b'),
    track: read('--pt-track', '#e8eeeb'),
  };
}

// --- Drawing -----------------------------------------------------------------------------------

interface Word {
  text: string;
  emphasis: boolean;
  /** Whether a space separates it from the word before (on the same line). */
  space: boolean;
}

/** The headline as words; the emphasized part ("79.00%", "6 days 22 h") is one unbreakable word. */
function headlineWords(card: ShareCard): Word[] {
  const at = card.emphasis ? card.headline.indexOf(card.emphasis) : -1;
  const plain = (text: string, spaceFirst: boolean): Word[] =>
    text
      .split(' ')
      .filter(Boolean)
      .map((word, index) => ({ text: word, emphasis: false, space: index > 0 || spaceFirst }));
  if (at < 0) return plain(card.headline, false);
  const before = card.headline.slice(0, at);
  const after = card.headline.slice(at + card.emphasis.length);
  return [
    ...plain(before, false),
    { text: card.emphasis, emphasis: true, space: before.endsWith(' ') },
    ...plain(after, after.startsWith(' ')),
  ];
}

/** Sets the font for a word; the mono percentage is set a little tighter, like on the page. */
function useFont(context: CanvasRenderingContext2D, word: Word, size: number): void {
  context.font = word.emphasis ? `600 ${size}px ${FONT_MONO}` : `750 ${size}px ${FONT_SANS}`;
  context.letterSpacing = word.emphasis ? `${-0.04 * size}px` : '0px';
}

/** Greedy line breaking; a single word that is too wide is cut with an ellipsis. */
function layoutWords(context: CanvasRenderingContext2D, words: Word[], size: number, maxWidth: number): Word[][] {
  context.font = `750 ${size}px ${FONT_SANS}`;
  const space = context.measureText(' ').width;
  const width = (word: Word) => {
    useFont(context, word, size);
    return context.measureText(word.text).width;
  };
  const lines: Word[][] = [[]];
  let x = 0;
  for (const original of words) {
    let word = original;
    let w = width(word);
    const line = lines[lines.length - 1]!;
    const gap = line.length > 0 && word.space ? space : 0;
    if (line.length > 0 && x + gap + w > maxWidth) {
      lines.push([]);
      x = 0;
    }
    if (w > maxWidth) {
      let text = word.text;
      while (text.length > 1 && w > maxWidth) {
        text = Array.from(text).slice(0, -1).join('');
        word = { ...word, text: `${text.trimEnd()}…` };
        w = width(word);
      }
    }
    const current = lines[lines.length - 1]!;
    x += (current.length > 0 && word.space ? space : 0) + w;
    current.push(word);
  }
  return lines;
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  context.beginPath();
  context.roundRect(x, y, w, h, r);
}

/** The Progress Tab icon (a mint tile with a three-quarter ring), drawn as shapes. */
function drawLogo(context: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const scale = size / 128;
  roundRect(context, x, y, size, size, 28 * scale);
  context.fillStyle = BRAND;
  context.fill();
  const cx = x + 64 * scale;
  const cy = y + 64 * scale;
  context.lineWidth = 15 * scale;
  context.lineCap = 'round';
  context.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  context.beginPath();
  context.arc(cx, cy, 36 * scale, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = '#ffffff';
  context.beginPath();
  context.arc(cx, cy, 36 * scale, -Math.PI / 2, Math.PI);
  context.stroke();
}

/**
 * Draws a card at 1200×630: page background, a card in the surface color, a small label, the
 * headline (the percentage in the accent color), 20 blocks like the Telegram bot's ▓░ bar, a
 * caption, and the Progress Tab wordmark with the date.
 */
export function drawShareCard(canvas: HTMLCanvasElement, card: ShareCard, palette: Palette): void {
  canvas.width = SHARE_WIDTH;
  canvas.height = SHARE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('this browser can’t draw images here');
  const inset = 44;
  const pad = 76;
  const left = inset + pad;
  const width = SHARE_WIDTH - 2 * left;

  context.fillStyle = palette.page;
  context.fillRect(0, 0, SHARE_WIDTH, SHARE_HEIGHT);
  roundRect(context, inset, inset, SHARE_WIDTH - 2 * inset, SHARE_HEIGHT - 2 * inset, 28);
  context.fillStyle = palette.surface;
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = palette.border;
  context.stroke();

  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';

  // Label on top.
  context.font = `750 21px ${FONT_SANS}`;
  context.letterSpacing = '2.5px';
  context.fillStyle = palette.muted;
  context.fillText(card.eyebrow.toUpperCase(), left, inset + 78);
  context.letterSpacing = '0px';

  // Headline: as large as fits in two lines.
  const words = headlineWords(card);
  let size = 70;
  let lines = layoutWords(context, words, size, width);
  while (lines.length > 2 && size > 46) {
    size -= 6;
    lines = layoutWords(context, words, size, width);
  }
  if (lines.length > 2) {
    const kept = lines.slice(0, 2);
    const last = kept[1]!;
    const tail = last[last.length - 1];
    if (tail) last[last.length - 1] = { ...tail, text: `${tail.text}…` };
    lines = kept;
  }
  const lineHeight = Math.round(size * 1.16);
  const hasBar = card.fraction !== null;
  const barHeight = 58;
  const captionSize = 27;
  const blockHeight = lines.length * lineHeight + (hasBar ? 34 + barHeight : 0) + 26 + captionSize;
  // Centered between the label and the footer.
  const top = inset + 110 + Math.max(0, (SHARE_HEIGHT - 2 * inset - 110 - 96 - blockHeight) / 2);
  let y = top + size;
  context.font = `750 ${size}px ${FONT_SANS}`;
  context.letterSpacing = '0px';
  const space = context.measureText(' ').width;
  for (const line of lines) {
    let x = left;
    line.forEach((word, index) => {
      if (index > 0 && word.space) x += space;
      useFont(context, word, size);
      context.fillStyle = word.emphasis ? palette.accentText : palette.text;
      context.fillText(word.text, x, y);
      x += context.measureText(word.text).width;
    });
    y += lineHeight;
  }
  context.letterSpacing = '0px';
  y += -lineHeight + Math.round(size * 0.3);

  // 20 blocks: full ones in the accent color, the rest in the track color.
  if (hasBar) {
    y += 34;
    const gap = 8;
    const block = (width - gap * (SHARE_BLOCKS - 1)) / SHARE_BLOCKS;
    for (let index = 0; index < SHARE_BLOCKS; index++) {
      roundRect(context, left + index * (block + gap), y, block, barHeight, 6);
      context.fillStyle = index < card.blocks ? palette.accent : palette.track;
      context.fill();
    }
    y += barHeight;
  }

  y += 26 + captionSize;
  context.font = `550 ${captionSize}px ${FONT_SANS}`;
  context.fillStyle = palette.muted;
  let caption = card.caption;
  while (caption.length > 1 && context.measureText(caption).width > width) caption = `${caption.slice(0, -2).trimEnd()}…`;
  context.fillText(caption, left, y);

  // Footer: wordmark on the left, the date on the right.
  const footer = SHARE_HEIGHT - inset - 50;
  drawLogo(context, left, footer - 30, 38);
  context.font = `750 25px ${FONT_SANS}`;
  context.fillStyle = palette.text;
  context.fillText('Progress Tab', left + 52, footer - 2);
  context.font = `550 21px ${FONT_SANS}`;
  context.fillStyle = palette.muted;
  context.textAlign = 'right';
  context.fillText(card.dateline, left + width, footer - 3);
}

// --- Dialog ------------------------------------------------------------------------------------

/**
 * "Share" next to the year: a preview of the card, what to put on it (year, month, Life in weeks,
 * a countdown), Download PNG (a plain download link, no permission) and Copy image (the async
 * clipboard API, which extension pages may use from a click without the clipboardWrite
 * permission). Nothing is uploaded anywhere: sharing the file is up to the user.
 */
export class ShareDialog {
  private readonly dialog = byId<HTMLDialogElement>('share');
  private readonly canvas = h('canvas', { class: 'share-canvas', attrs: { role: 'img', width: String(SHARE_WIDTH), height: String(SHARE_HEIGHT) } });
  private readonly preview = h('div', { class: 'share-preview', attrs: { 'data-state': 'idle' } });
  private readonly kindInputs = new Map<ShareKind, HTMLInputElement>();
  private readonly countdownSelect = h('select', { class: 'form-select form-select-sm', attrs: { id: 'share-countdown', 'aria-label': 'Countdown to share' } });
  private readonly noteText = h('span');
  private readonly noteLink: HTMLButtonElement;
  private readonly note: HTMLParagraphElement;
  private readonly download: HTMLAnchorElement;
  private readonly copy: HTMLButtonElement;
  private readonly status = h('p', { class: 'share-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly error = h('div', { class: 'alert alert-danger alert-with-icon', attrs: { role: 'alert', hidden: '' } });
  private kind: ShareKind = 'year';
  private url: string | null = null;
  private blob: Promise<Blob> | null = null;
  private version = 0;
  private returnFocus: HTMLElement | null = null;

  constructor(
    private readonly context: () => ShareContext,
    private readonly aboutPro: () => void,
  ) {
    const kinds = h('div', { class: 'btn-group btn-group-sm share-kinds' });
    for (const kind of ['year', 'month', 'life', 'countdown'] as const) {
      const id = `share-kind-${kind}`;
      const input = h('input', {
        class: 'btn-check',
        attrs: { type: 'radio', name: 'share-kind', id, value: kind, autocomplete: 'off', 'aria-describedby': 'share-note' },
        on: {
          change: () => {
            if (!input.checked) return;
            this.kind = kind;
            void this.render();
          },
        },
      });
      this.kindInputs.set(kind, input);
      kinds.append(input, h('label', { class: 'btn btn-segment', attrs: { for: id } }, KIND_LABELS[kind], kind === 'life' ? proBadge() : null));
    }
    this.countdownSelect.addEventListener('change', () => void this.render());
    this.noteLink = h('button', { class: 'btn btn-link btn-sm link-inline', attrs: { type: 'button' }, text: 'About Pro', on: { click: () => this.openAboutPro() } });
    this.note = h('p', { class: 'share-note', attrs: { id: 'share-note' } }, icon('infoCircle'), h('span', {}, this.noteText, ' ', this.noteLink));

    this.download = h('a', { class: 'btn btn-primary btn-sm', attrs: { 'aria-disabled': 'true' } }, icon('download'), ' Download PNG');
    this.download.addEventListener('click', (event) => {
      if (!this.url) event.preventDefault();
      else this.setStatus('Downloading. The image is in your downloads folder.', false);
    });
    this.copy = h('button', { class: 'btn btn-quiet btn-sm', attrs: { type: 'button' }, on: { click: () => this.copyImage() } }, icon('copy'), ' Copy image');
    // Without the async clipboard API (or ClipboardItem) only Download is offered.
    setHidden(this.copy, !(typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function'));

    const close = h('button', { class: 'btn-close', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => this.dialog.close() } });
    this.preview.append(this.canvas, h('span', { class: 'share-rendering', text: 'Drawing…' }));
    this.dialog.replaceChildren(
      h('div', { class: 'share-header' }, h('h2', { attrs: { id: 'share-title' }, text: 'Share your progress' }), close),
      h(
        'div',
        { class: 'share-body' },
        h('fieldset', { class: 'share-options' }, h('legend', { class: 'visually-hidden', text: 'What to share' }), kinds, this.countdownSelect),
        this.note,
        this.preview,
        this.error,
        h('div', { class: 'share-actions' }, this.download, this.copy, this.status),
        h('p', { class: 'share-privacy' }, icon('shieldCheck'), h('span', { text: 'The image is made on this page. Nothing is uploaded; share the file wherever you like.' })),
      ),
    );
    this.dialog.setAttribute('aria-labelledby', 'share-title');
    this.dialog.addEventListener('close', () => {
      this.version++;
      this.revoke();
      this.returnFocus?.focus();
      this.returnFocus = null;
    });
    // A click on the backdrop (outside the panel) closes, like Esc.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(from: HTMLElement): void {
    this.returnFocus = from;
    this.setStatus('', false);
    this.dialog.showModal();
    this.kindInputs.get(this.kind)?.focus();
    void this.render();
  }

  /** Enables the options the page can offer right now, then draws the chosen card. */
  private async render(): Promise<void> {
    const version = ++this.version;
    const context = this.context();
    const upcoming = sortCountdowns(context.countdowns, context.now).filter((countdown) => countdownState(countdown, context.now) !== 'passed');
    const lifeView = context.lifeEntitled ? describeLife(context.settings.life, context.now, decimalsFor('year', context.settings.decimals)) : null;

    this.syncCountdownOptions(upcoming);
    const available: Record<ShareKind, boolean> = { year: true, month: true, life: lifeView !== null, countdown: upcoming.length > 0 };
    if (!available[this.kind]) this.kind = 'year';
    for (const [kind, input] of this.kindInputs) {
      if (input.disabled !== !available[kind]) input.disabled = !available[kind];
      input.checked = kind === this.kind;
    }
    setHidden(this.countdownSelect, this.kind !== 'countdown');
    const notes: string[] = [];
    if (!context.lifeEntitled) notes.push('Life in weeks is part of Pro.');
    else if (!lifeView) notes.push('To share Life in weeks, set your birth date in its card first.');
    if (upcoming.length === 0) notes.push('Add a countdown to share it.');
    setText(this.noteText, notes.join(' '));
    setHidden(this.note, notes.length === 0);
    setHidden(this.noteLink, context.lifeEntitled);

    const card = this.cardFor(context, upcoming, lifeView);
    if (!card) return;
    this.preview.dataset.state = 'rendering';
    this.blob = null;
    this.setDownload(null, card.fileName);
    this.showError(null);
    try {
      await document.fonts.load(`750 70px ${FONT_SANS}`, card.headline);
      if (card.emphasis) await document.fonts.load(`600 70px ${FONT_MONO}`, card.emphasis);
      if (version !== this.version) return;
      drawShareCard(this.canvas, card, currentPalette());
      setAttr(this.canvas, 'aria-label', `Preview: ${shareCardText(card)}`);
      this.canvas.dataset.kind = card.kind;
      const blob = new Promise<Blob>((resolve, reject) =>
        this.canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('the image couldn’t be created'))), 'image/png'),
      );
      this.blob = blob;
      const url = URL.createObjectURL(await blob);
      if (version !== this.version) {
        URL.revokeObjectURL(url);
        return;
      }
      this.setDownload(url, card.fileName);
      this.preview.dataset.state = 'ready';
    } catch (error) {
      if (version !== this.version) return;
      this.preview.dataset.state = 'error';
      this.showError(`Couldn’t create the image: ${errorMessage(error)}. Try again, or take a screenshot instead.`);
    }
  }

  private cardFor(context: ShareContext, upcoming: Countdown[], lifeView: ReturnType<typeof describeLife>): ShareCard | null {
    const { now, settings } = context;
    switch (this.kind) {
      case 'year':
        return yearCard(now, { weekStart: settings.weekStart, decimals: decimalsFor('year', settings.decimals) });
      case 'month':
        return monthCard(now, { weekStart: settings.weekStart, decimals: decimalsFor('month', settings.decimals) });
      case 'life':
        return lifeView ? lifeCard(lifeView, now) : null;
      case 'countdown': {
        const chosen = upcoming.find((countdown) => countdown.id === this.countdownSelect.value) ?? upcoming[0];
        return chosen ? countdownCard(chosen, now, { hour12: context.hour12, decimals: countdownDecimals(settings.decimals) }) : null;
      }
    }
  }

  private syncCountdownOptions(upcoming: Countdown[]): void {
    const selected = this.countdownSelect.value;
    this.countdownSelect.replaceChildren(...upcoming.map((countdown) => h('option', { attrs: { value: countdown.id }, text: countdown.name })));
    if (upcoming.some((countdown) => countdown.id === selected)) this.countdownSelect.value = selected;
  }

  private setDownload(url: string | null, fileName: string): void {
    this.revoke();
    this.url = url;
    if (url) {
      this.download.href = url;
      this.download.removeAttribute('aria-disabled');
    } else {
      this.download.removeAttribute('href');
      this.download.setAttribute('aria-disabled', 'true');
    }
    this.download.download = fileName;
    this.copy.disabled = url === null;
  }

  private revoke(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  /** Must run synchronously in the click (user activation); the blob itself may still be pending. */
  private copyImage(): void {
    const blob = this.blob;
    if (!blob) return;
    this.setStatus('', false);
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(
      () => this.setStatus('Copied. Paste it into a chat or post.', false),
      (error: unknown) => this.setStatus(`Couldn’t copy the image (${errorMessage(error)}). Use Download PNG instead.`, true),
    );
  }

  private openAboutPro(): void {
    // Focus goes to the About Pro card, not back to the Share button.
    this.returnFocus = null;
    this.dialog.close();
    this.aboutPro();
  }

  private setStatus(message: string, isError: boolean): void {
    this.status.classList.toggle('is-error', isError);
    this.status.replaceChildren(...(message ? [icon(isError ? 'exclamationTriangleFill' : 'check2'), h('span', { text: message })] : []));
  }

  private showError(message: string | null): void {
    this.error.replaceChildren(...(message ? [icon('exclamationTriangleFill'), h('span', { text: message })] : []));
    setHidden(this.error, !message);
  }
}
