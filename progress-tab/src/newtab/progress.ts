import { describeClock, describePeriod } from '../core/periods';
import { decimalsFor, type Settings } from '../core/settings';
import { PERIOD_KINDS, type PeriodKind } from '../core/time';
import { h, setAttr, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { renderDuration } from './duration';

const PROGRESS_LABELS: Record<PeriodKind, string> = {
  year: 'Year progress',
  month: 'Month progress',
  week: 'Week progress',
  day: 'Day progress',
};

export interface Bar {
  track: HTMLDivElement;
  fill: HTMLDivElement;
  /** Last written transform, so unchanged values aren't written again. */
  scale: string;
}

/** Bootstrap progress bar with the ARIA progressbar role on the track. */
export function createBar(label: string, className = ''): Bar {
  const fill = h('div', { class: 'progress-bar' });
  const track = h(
    'div',
    { class: className ? `progress ${className}` : 'progress', attrs: { role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' } },
    fill,
  );
  return { track, fill, scale: '' };
}

/** Moves the bar with a transform (compositor only) and updates its ARIA values. */
export function updateBar(bar: Bar, fraction: number, valueNow: number, valueText: string): void {
  // 1/10000 is far below a pixel; rounding keeps the write rate low.
  const scale = `scaleX(${Math.round(fraction * 10_000) / 10_000})`;
  if (bar.scale !== scale) {
    bar.fill.style.transform = scale;
    bar.scale = scale;
  }
  setAttr(bar.track, 'aria-valuenow', String(valueNow));
  setAttr(bar.track, 'aria-valuetext', valueText);
}

interface PeriodRow {
  kind: PeriodKind;
  root: HTMLLIElement;
  label: HTMLSpanElement;
  percent: HTMLSpanElement;
  caption: HTMLSpanElement;
  /** Visible "76 d 14 h left" (units muted) and the spoken "76 days 14 h left". */
  left: HTMLSpanElement;
  leftShort: HTMLSpanElement;
  leftSpoken: HTMLSpanElement;
  bar: Bar;
}

function rowParts(kind: PeriodKind, barClass = '') {
  const leftShort = h('span', { class: 'dur', attrs: { 'aria-hidden': 'true' } });
  const leftSpoken = h('span', { class: 'visually-hidden' });
  return {
    kind,
    label: h('span', { class: 'period-label' }),
    percent: h('span', { class: 'period-percent' }),
    caption: h('span', { class: 'period-caption' }),
    left: h('span', { class: 'period-left' }, leftShort, leftSpoken),
    leftShort,
    leftSpoken,
    bar: createBar(PROGRESS_LABELS[kind], barClass),
  };
}

/**
 * The year is the hero: a big percentage and a thick 20-segment bar (the ▓░ bar of the Telegram
 * bot, still one progressbar), with the Share button next to it.
 */
function createHeroRow(kind: PeriodKind, onShare: () => void): PeriodRow {
  const parts = rowParts(kind, 'progress-segmented');
  const share = h(
    'button',
    { class: 'btn btn-quiet btn-sm share-open', attrs: { type: 'button', 'aria-haspopup': 'dialog' }, on: { click: onShare } },
    icon('boxArrowUp'),
    ' Share',
  );
  // "79.00% of 2026": the label sits on the percentage's baseline.
  const root = h(
    'li',
    { class: 'list-group-item period period-hero', attrs: { 'data-kind': kind } },
    h('div', { class: 'period-head' }, parts.percent, h('span', { class: 'period-of' }, 'of ', parts.label), share),
    parts.bar.track,
    h('div', { class: 'period-foot' }, parts.caption, parts.left),
  );
  return { ...parts, root };
}

/** Month, week and day: one compact row each (label and caption, a thin bar, percent and time left). */
function createCompactRow(kind: PeriodKind): PeriodRow {
  const parts = rowParts(kind);
  const root = h(
    'li',
    { class: 'list-group-item period period-compact', attrs: { 'data-kind': kind } },
    parts.label,
    parts.caption,
    parts.bar.track,
    parts.percent,
    parts.left,
  );
  return { ...parts, root };
}

/** Year, month, week and day rows. */
export class PeriodList {
  private readonly rows: PeriodRow[];

  constructor(list: HTMLUListElement, onShare: () => void) {
    this.rows = PERIOD_KINDS.map((kind) => (kind === 'year' ? createHeroRow(kind, onShare) : createCompactRow(kind)));
    list.replaceChildren(...this.rows.map((row) => row.root));
  }

  update(now: Date, settings: Settings): void {
    for (const row of this.rows) {
      const visible = settings.widgets[row.kind];
      setHidden(row.root, !visible);
      if (!visible) continue;
      const view = describePeriod(row.kind, now, { weekStart: settings.weekStart, decimals: decimalsFor(row.kind, settings.decimals) });
      setText(row.label, view.label);
      setText(row.percent, view.percent.text);
      setText(row.caption, view.caption);
      renderDuration(row.leftShort, view.remainingTokens, 'left');
      setText(row.leftSpoken, view.remainingText);
      updateBar(row.bar, view.fraction, view.percent.value, `${view.percent.text}, ${view.remainingText}`);
    }
  }
}

export class Clock {
  constructor(
    private readonly time: HTMLElement,
    private readonly date: HTMLElement,
  ) {}

  update(now: Date, hour12: boolean): void {
    const view = describeClock(now, hour12);
    setText(this.time, view.time);
    setText(this.date, view.date);
  }
}
