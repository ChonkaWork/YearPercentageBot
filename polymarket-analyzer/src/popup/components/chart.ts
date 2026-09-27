import { chartGeometry, nearestPoint, type ChartBox } from '../../core/chartGeometry';
import { formatDateTime, formatProbability } from '../../core/format';
import type { HistoryRange, PricePoint } from '../../core/types';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BOX: ChartBox = { width: 344, height: 150, padding: { top: 10, right: 38, bottom: 18, left: 2 } };
const COLORS = { up: '#20c77a', down: '#f2555a', flat: '#6f8cff' } as const;

let gradientId = 0;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  return element;
}

/** Line chart with grid, significant-move markers, current value and a hover readout. */
export function priceChart(history: readonly PricePoint[], range: HistoryRange): HTMLElement {
  const geometry = chartGeometry(history, range, BOX);
  if (!geometry) return chartEmpty('Not enough price history to draw a chart.');

  const color = COLORS[geometry.direction];
  const id = `pm-area-${++gradientId}`;
  const root = svg('svg', { viewBox: `0 0 ${BOX.width} ${BOX.height}`, class: 'chart', role: 'img', 'aria-label': geometry.summary });

  const defs = svg('defs');
  const gradient = svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.28 }), svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
  defs.append(gradient);
  root.append(defs);

  // The current-value pill sits in the label column; tick labels it would cover are skipped.
  const pillY = Math.min(Math.max(geometry.last.y - 8, 0), BOX.height - BOX.padding.bottom - 16);
  const grid = svg('g', { class: 'grid' });
  for (const tick of geometry.yTicks) {
    grid.append(svg('line', { x1: BOX.padding.left, x2: BOX.width - BOX.padding.right, y1: tick.y, y2: tick.y }));
    if (Math.abs(tick.y - (pillY + 8)) < 13) continue;
    const label = svg('text', { x: BOX.width - 2, y: tick.y + 3, 'text-anchor': 'end', class: 'tick' });
    label.textContent = tick.label;
    grid.append(label);
  }
  geometry.xTicks.forEach((tick, index) => {
    const anchor = index === 0 ? 'start' : index === geometry.xTicks.length - 1 ? 'end' : 'middle';
    const x = index === geometry.xTicks.length - 1 ? BOX.width - BOX.padding.right : tick.x;
    const label = svg('text', { x, y: BOX.height - 4, 'text-anchor': anchor, class: 'tick' });
    label.textContent = tick.label;
    grid.append(label);
  });
  root.append(grid);

  root.append(svg('path', { d: geometry.area, fill: `url(#${id})`, stroke: 'none' }));
  root.append(svg('path', { d: geometry.line, class: 'line', stroke: color }));

  for (const marker of geometry.markers) {
    const group = svg('g', { class: 'marker' });
    const markerColor = COLORS[marker.direction];
    group.append(svg('circle', { cx: marker.x, cy: marker.y, r: 3.5, fill: markerColor }));
    const above = marker.direction === 'up';
    const plotBottom = BOX.height - BOX.padding.bottom;
    // Keep the label inside the plot, and left of the value column.
    const labelY = above ? marker.y - 7 : marker.y + 13;
    const label = svg('text', {
      x: Math.min(Math.max(marker.x, 16), BOX.width - BOX.padding.right - 20),
      y: Math.min(Math.max(labelY, BOX.padding.top + 2), plotBottom - 3),
      'text-anchor': 'middle',
      fill: markerColor,
    });
    label.textContent = marker.label;
    const title = svg('title');
    title.textContent = `Significant move: ${marker.label} pp`;
    group.append(label, title);
    root.append(group);
  }

  // Current value: dot on the line and a pill in the label column.
  root.append(svg('circle', { cx: geometry.last.x, cy: geometry.last.y, r: 3.5, fill: color, stroke: '#0b1020', 'stroke-width': 1.5 }));
  const pill = svg('g', { class: 'last-label' });
  pill.append(svg('rect', { x: BOX.width - BOX.padding.right + 3, y: pillY, width: BOX.padding.right - 3, height: 16, rx: 4, fill: color }));
  const pillText = svg('text', { x: BOX.width - BOX.padding.right / 2 + 1.5, y: pillY + 11.5, 'text-anchor': 'middle' });
  pillText.textContent = geometry.last.label.replace('%', '');
  pill.append(pillText);
  root.append(pill);

  // Hover readout.
  const crosshair = svg('g', { class: 'crosshair', visibility: 'hidden' });
  const crossLine = svg('line', { y1: BOX.padding.top, y2: BOX.height - BOX.padding.bottom });
  const crossDot = svg('circle', { r: 3.5, fill: '#fff' });
  crosshair.append(crossLine, crossDot);
  root.append(crosshair);

  const tooltip = h('div', { class: 'chart-tooltip num', attrs: { hidden: '' } });
  const wrapper = h('div', { class: 'position-relative' }, root, tooltip);

  root.addEventListener('pointermove', (event) => {
    const bounds = root.getBoundingClientRect();
    const scale = BOX.width / bounds.width;
    const x = (event.clientX - bounds.left) * scale;
    const point = geometry.points[nearestPoint(geometry.points, x)]!;
    crossLine.setAttribute('x1', String(point.x));
    crossLine.setAttribute('x2', String(point.x));
    crossDot.setAttribute('cx', String(point.x));
    crossDot.setAttribute('cy', String(point.y));
    crosshair.setAttribute('visibility', 'visible');
    tooltip.textContent = `${formatProbability(point.p)} · ${formatDateTime(point.t)}`;
    tooltip.hidden = false;
    const left = Math.min(Math.max(point.x / scale, 60), bounds.width - 60);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${point.y / scale - 8}px`;
  });
  root.addEventListener('pointerleave', () => {
    crosshair.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  });

  return wrapper;
}

export function chartEmpty(message: string): HTMLElement {
  return h('div', { class: 'chart-empty' }, icon('barChartLine'), h('span', { text: message }));
}

export function chartLoading(): HTMLElement {
  return h('div', { class: 'chart-empty skeleton placeholder-glow', attrs: { 'aria-busy': 'true' } }, h('span', { class: 'placeholder col-10' }), h('span', { class: 'placeholder col-7' }));
}
