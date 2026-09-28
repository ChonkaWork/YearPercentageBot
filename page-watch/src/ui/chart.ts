import { chartGeometry, nearestPoint, type ChartPoint, type ValuePoint } from '../core/history';
import { h } from './dom';

/**
 * Value history charts, drawn as inline SVG with createElementNS (values from pages only ever
 * go into text nodes). One series, so no legend: the section label says what it is. The line
 * is a step line because a value holds until a check sees a different one.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  return element;
}

const dayFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const pointFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** "Sep 27" or "Today". */
export function dayLabel(timestamp: number, now = Date.now()): string {
  return new Date(timestamp).toDateString() === new Date(now).toDateString() ? 'Today' : dayFormat.format(timestamp);
}

/** Small trend line for the watch row: the recent values in a muted color, the current one as an accent dot. */
export function sparkline(points: readonly ValuePoint[], label: string, width = 64, height = 22): SVGSVGElement {
  const recent = points.slice(-30);
  const root = svg('svg', { class: 'sparkline', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': label });
  const geometry = chartGeometry(recent, { width, height, top: 3, right: 4, bottom: 3, left: 1 });
  if (!geometry) return root;
  root.append(
    svg('path', { class: 'sparkline-line', d: geometry.line }),
    svg('circle', { class: 'sparkline-dot', cx: geometry.last.x, cy: geometry.last.y, r: 2.5 }),
  );
  return root;
}

export interface HistoryChartOptions {
  /** "Price" or "Value", for labels. */
  noun: string;
  now?: number;
}

const WIDTH = 344;
const HEIGHT = 132;
const BOX = { width: WIDTH, height: HEIGHT, top: 20, right: 10, bottom: 24, left: 10 };

/**
 * The expanded view's chart: min and max labelled on the line, first and last date under it,
 * and a crosshair with the value and time under the pointer (or the arrow keys).
 */
export function historyChart(points: readonly ValuePoint[], options: HistoryChartOptions): HTMLElement {
  const geometry = chartGeometry(points, BOX)!;
  const now = options.now ?? Date.now();
  const root = svg('svg', {
    class: 'history-svg',
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: 'img',
    tabindex: 0,
    'aria-label': `${options.noun} history, ${dayLabel(points[0]!.t, now)} to ${dayLabel(points[points.length - 1]!.t, now)}: lowest ${geometry.min.point.r}, highest ${geometry.max.point.r}, now ${geometry.last.point.r}. Use the arrow keys to read each value.`,
  });
  const baseline = svg('line', { class: 'history-axis', x1: geometry.x0, x2: geometry.x1, y1: geometry.y1 + 4, y2: geometry.y1 + 4 });
  const area = svg('path', { class: 'history-area', d: geometry.area });
  const line = svg('path', { class: 'history-line', d: geometry.line });
  root.append(baseline, area, line);

  // Direct labels on the extremes (text colors, never the line's).
  const labelAt = (point: ChartPoint, above: boolean, text: string) => {
    const anchor = point.x < 50 ? 'start' : point.x > WIDTH - 50 ? 'end' : 'middle';
    const label = svg('text', { class: 'history-label', x: point.x, y: above ? point.y - 7 : point.y + 14, 'text-anchor': anchor });
    label.textContent = text;
    return label;
  };
  if (geometry.max.point.v !== geometry.min.point.v) {
    root.append(labelAt(geometry.max, true, `High ${geometry.max.point.r}`), labelAt(geometry.min, geometry.min.y > HEIGHT - 50, `Low ${geometry.min.point.r}`));
  }
  const start = svg('text', { class: 'history-date', x: geometry.x0, y: HEIGHT - 4, 'text-anchor': 'start' });
  start.textContent = dayLabel(points[0]!.t, now);
  const end = svg('text', { class: 'history-date', x: geometry.x1, y: HEIGHT - 4, 'text-anchor': 'end' });
  end.textContent = dayLabel(points[points.length - 1]!.t, now);
  root.append(start, end);

  const endRing = svg('circle', { class: 'history-end-ring', cx: geometry.last.x, cy: geometry.last.y, r: 6 });
  const endDot = svg('circle', { class: 'history-end', cx: geometry.last.x, cy: geometry.last.y, r: 4 });
  root.append(endRing, endDot);

  // Crosshair and tooltip.
  const cross = svg('line', { class: 'history-cross', y1: geometry.y0 - 6, y2: geometry.y1 + 4 });
  const ring = svg('circle', { class: 'history-end-ring', r: 6 });
  const dot = svg('circle', { class: 'history-end', r: 4 });
  const hover = svg('g', { class: 'history-hover', visibility: 'hidden' });
  hover.append(cross, ring, dot);
  root.append(hover);
  const tip = h('div', { class: 'history-tip', attrs: { hidden: '' } });
  const live = h('div', { class: 'visually-hidden', attrs: { 'aria-live': 'polite' } });
  const wrapper = h('div', { class: 'history-chart' }, root, tip, live);

  let current = geometry.points.length - 1;
  const show = (point: ChartPoint, announce: boolean) => {
    for (const element of [cross]) {
      element.setAttribute('x1', String(point.x));
      element.setAttribute('x2', String(point.x));
    }
    for (const element of [ring, dot]) {
      element.setAttribute('cx', String(point.x));
      element.setAttribute('cy', String(point.y));
    }
    hover.setAttribute('visibility', 'visible');
    const value = h('strong', { class: 'mono', text: point.point.r });
    const when = h('span', { text: pointFormat.format(point.point.t) });
    tip.replaceChildren(value, when);
    tip.hidden = false;
    const left = (point.x / WIDTH) * 100;
    tip.style.left = `${Math.min(78, Math.max(22, left))}%`;
    if (announce) live.textContent = `${point.point.r} on ${pointFormat.format(point.point.t)}`;
  };
  const hide = () => {
    hover.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  root.addEventListener('pointermove', (event) => {
    const rect = root.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const point = nearestPoint(geometry.points, x);
    if (!point) return;
    current = geometry.points.indexOf(point);
    show(point, false);
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('blur', hide);
  root.addEventListener('focus', () => show(geometry.points[current]!, true));
  root.addEventListener('keydown', (event) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (event.key === 'Escape') {
      hide();
      return;
    }
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    current = Math.max(0, Math.min(geometry.points.length - 1, Number.isFinite(move) ? current + move : move < 0 ? 0 : geometry.points.length - 1));
    show(geometry.points[current]!, true);
  });
  return wrapper;
}
