import { chartGeometry, nearestIndex } from '../core/chart';
import { formatDateTime, formatPrice } from '../core/format';
import type { Analysis } from '../core/signal';
import type { Interval } from '../core/types';
import { h, svg } from '../ui/dom';

export type Tone = 'up' | 'down' | 'neutral';

const WIDTH = 348;
const HEIGHT = 112;
const COLORS = { price: '#eaecef', ema20: '#f0b90b', ema50: '#5b8def', surface: '#0b0e11', grid: '#1a1f25' };
const TONE_COLOR: Record<Tone, string> = { up: '#0ecb81', down: '#f6465d', neutral: '#9aa3ae' };

let gradientId = 0;

/**
 * Mini price chart: closing price with EMA20 and EMA50, last price marked. Hover or focus it
 * and use ←/→ for a crosshair with the values of each candle.
 */
export function renderChart(analysis: Analysis, options: { interval: Interval; tone: Tone; showEmas: boolean }): HTMLElement {
  const series = analysis.chart;
  const emaNone = series.ema20.map(() => null);
  const geometry = chartGeometry(
    { close: series.close, ema20: options.showEmas ? series.ema20 : emaNone, ema50: options.showEmas ? series.ema50 : emaNone },
    { width: WIDTH, height: HEIGHT, padTop: 8, padRight: 6, padBottom: 8, padLeft: 2 },
  );

  const legend = h(
    'div',
    { class: 'chart-legend' },
    legendItem('Price', COLORS.price),
    options.showEmas ? legendItem('EMA20', COLORS.ema20) : null,
    options.showEmas ? legendItem('EMA50', COLORS.ema50) : null,
    h('span', { class: 'legend-span', text: `Last ${series.close.length} × ${options.interval}` }),
  );

  if (!geometry) {
    return h('div', { class: 'chart-block' }, legend, h('p', { class: 'text-body-secondary small m-0', text: 'Not enough prices to draw a chart.' }));
  }

  const id = `cs-area-${++gradientId}`;
  const first = series.close[0]!;
  const last = series.close[series.close.length - 1]!;
  const label =
    `Price chart of the last ${series.close.length} ${options.interval} candles, from ${formatPrice(first)} to ${formatPrice(last)}` +
    `, high ${formatPrice(geometry.high.value)}, low ${formatPrice(geometry.low.value)}. Use the left and right arrow keys to read each candle.`;

  const crosshair = svg('line', { x1: 0, x2: 0, y1: 0, y2: HEIGHT, stroke: '#5e6673', 'stroke-width': 1, visibility: 'hidden' });
  const hoverDot = svg('circle', { r: 4, fill: COLORS.price, stroke: COLORS.surface, 'stroke-width': 2, visibility: 'hidden' });

  const chartSvg = svg(
    'svg',
    { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, width: WIDTH, height: HEIGHT, 'aria-hidden': 'true' },
    svg(
      'defs',
      {},
      svg(
        'linearGradient',
        { id, x1: 0, y1: 0, x2: 0, y2: 1 },
        svg('stop', { offset: 0, 'stop-color': TONE_COLOR[options.tone], 'stop-opacity': 0.16 }),
        svg('stop', { offset: 1, 'stop-color': TONE_COLOR[options.tone], 'stop-opacity': 0 }),
      ),
    ),
    ...[0.25, 0.5, 0.75].map((f) =>
      svg('line', { x1: 0, x2: WIDTH, y1: Math.round(HEIGHT * f) + 0.5, y2: Math.round(HEIGHT * f) + 0.5, stroke: COLORS.grid, 'stroke-width': 1 }),
    ),
    svg('path', { d: geometry.area, fill: `url(#${id})` }),
    geometry.ema50 ? line(geometry.ema50, COLORS.ema50, 1.5) : null,
    geometry.ema20 ? line(geometry.ema20, COLORS.ema20, 1.5) : null,
    line(geometry.price, COLORS.price, 2),
    crosshair,
    svg('circle', { cx: geometry.last.x, cy: geometry.last.y, r: 4, fill: COLORS.price, stroke: COLORS.surface, 'stroke-width': 2 }),
    hoverDot,
  );

  const tooltip = h('div', { class: 'chart-tooltip', attrs: { hidden: true } });
  const chart = h('div', { class: 'chart', attrs: { tabindex: 0, role: 'img', 'aria-label': label } }, chartSvg, tooltip);

  let active = -1;
  const show = (index: number) => {
    if (index < 0 || index >= geometry.points.length) return hide();
    active = index;
    const point = geometry.points[index]!;
    crosshair.setAttribute('x1', String(point.x));
    crosshair.setAttribute('x2', String(point.x));
    crosshair.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('cx', String(point.x));
    hoverDot.setAttribute('cy', String(point.y));
    hoverDot.setAttribute('visibility', 'visible');
    const rows = [h('div', { class: 'tt-time', text: formatDateTime(series.time[index]) }), tooltipRow('Price', COLORS.price, series.close[index] ?? null)];
    if (options.showEmas) {
      rows.push(tooltipRow('EMA20', COLORS.ema20, series.ema20[index] ?? null), tooltipRow('EMA50', COLORS.ema50, series.ema50[index] ?? null));
    }
    tooltip.replaceChildren(...rows);
    tooltip.hidden = false;
    const flip = point.x > WIDTH / 2;
    tooltip.style.left = flip ? `${Math.max(0, point.x - tooltip.offsetWidth - 10)}px` : `${point.x + 10}px`;
  };
  const hide = () => {
    active = -1;
    crosshair.setAttribute('visibility', 'hidden');
    hoverDot.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };

  chart.addEventListener('pointermove', (event) => {
    const rect = chartSvg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    show(nearestIndex(x, geometry.points));
  });
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('blur', hide);
  chart.addEventListener('keydown', (event) => {
    const lastIndex = geometry.points.length - 1;
    if (event.key === 'ArrowLeft') show(active < 0 ? lastIndex : Math.max(0, active - 1));
    else if (event.key === 'ArrowRight') show(active < 0 ? lastIndex : Math.min(lastIndex, active + 1));
    else if (event.key === 'Home') show(0);
    else if (event.key === 'End') show(lastIndex);
    else if (event.key === 'Escape') hide();
    else return;
    event.preventDefault();
  });

  return h('div', { class: 'chart-block' }, legend, chart);
}

function line(d: string, color: string, width: number): SVGPathElement {
  return svg('path', { d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
}

function legendItem(label: string, color: string): HTMLElement {
  const key = h('span', { class: 'legend-key' });
  key.style.setProperty('--key', color);
  return h('span', { class: 'legend-item' }, key, label);
}

function tooltipRow(label: string, color: string, value: number | null): HTMLElement {
  const key = h('span', { class: 'legend-key' });
  key.style.setProperty('--key', color);
  return h('div', { class: 'tt-row' }, key, h('span', { text: label }), h('span', { class: 'tt-value', text: formatPrice(value) }));
}
