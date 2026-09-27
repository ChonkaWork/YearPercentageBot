import { describeClock, describePeriod } from '../core/periods';
import { decimalsFor, type Settings } from '../core/settings';
import { PERIOD_KINDS, type PeriodKind } from '../core/time';
import { h, setAttr, setHidden, setText } from '../ui/dom';

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
export function createBar(label: string): Bar {
  const fill = h('div', { class: 'progress-bar' });
  const track = h(
    'div',
    { class: 'progress', attrs: { role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' } },
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
  left: HTMLSpanElement;
  bar: Bar;
}

function createRow(kind: PeriodKind): PeriodRow {
  const label = h('span', { class: 'period-label' });
  const percent = h('span', { class: 'period-percent' });
  const caption = h('span', { class: 'period-caption' });
  const left = h('span', { class: 'period-left' });
  const bar = createBar(PROGRESS_LABELS[kind]);
  const root = h(
    'li',
    { class: 'list-group-item period', attrs: { 'data-kind': kind } },
    h('div', { class: 'period-head' }, label, percent),
    bar.track,
    h('div', { class: 'period-foot' }, caption, left),
  );
  return { kind, root, label, percent, caption, left, bar };
}

/** Year, month, week and day rows. */
export class PeriodList {
  private readonly rows = PERIOD_KINDS.map(createRow);

  constructor(list: HTMLUListElement) {
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
      setText(row.left, view.remainingText);
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
