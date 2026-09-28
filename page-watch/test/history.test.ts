import { describe, expect, it } from 'vitest';
import { evaluateChange } from '../src/core/compare';
import {
  chartGeometry,
  DAY_MS,
  isValueMode,
  lowestSince,
  MAX_POINTS,
  nearestPoint,
  newLow,
  readValue,
  recordValue,
  sanitizeHistory,
  tracksValue,
  trend,
  visibleHistory,
  type ValuePoint,
} from '../src/core/history';

const NOW = Date.UTC(2026, 8, 28, 12);
const point = (daysAgo: number, v: number, r = `$${v.toFixed(2)}`): ValuePoint => ({ t: NOW - daysAgo * DAY_MS, v, r });

describe('reading values', () => {
  it('follows the first price, or the first number without one', () => {
    expect(readValue('$1,299.00 incl. VAT')).toMatchObject({ value: 1299, raw: '$1,299.00' });
    expect(readValue('Only 3 left · was 5')).toMatchObject({ value: 3 });
    expect(readValue('Sold out')).toBeNull();
  });

  it('number and price watches: value rules, or a picked element that is a short value', () => {
    expect(isValueMode('number') && isValueMode('below') && isValueMode('lowest')).toBe(true);
    expect(isValueMode('text') || isValueMode('keyword')).toBe(false);
    expect(tracksValue({ mode: 'text', selector: '#price' }, '$129.00')).toBe(true);
    expect(tracksValue({ mode: 'text', selector: '#price' }, 'In stock')).toBe(false);
    expect(tracksValue({ mode: 'text', selector: null }, '$129.00')).toBe(false);
    expect(tracksValue({ mode: 'text', selector: '#notes' }, 'Line 1\nLine 2 costs $5')).toBe(false);
    expect(tracksValue({ mode: 'number', selector: null }, 'whole page with 12 things')).toBe(true);
  });
});

describe('recording', () => {
  it('keeps every change and only the ends of a run of the same value', () => {
    let points: ValuePoint[] = [];
    for (const [day, v] of [
      [10, 129],
      [9, 129],
      [8, 129],
      [7, 129],
      [6, 99],
      [5, 99],
      [4, 109],
    ] as const) {
      points = recordValue(points, point(day, v));
    }
    expect(points.map((p) => [Math.round((NOW - p.t) / DAY_MS), p.v])).toEqual([
      [10, 129],
      [7, 129],
      [6, 99],
      [5, 99],
      [4, 109],
    ]);
  });

  it('caps the history, dropping the oldest points', () => {
    let points: ValuePoint[] = [];
    for (let i = 0; i < MAX_POINTS + 20; i++) points = recordValue(points, { t: i, v: i % 2, r: String(i % 2) });
    expect(points).toHaveLength(MAX_POINTS);
    expect(points[0]!.t).toBe(20);
  });

  it('reads the trend: current value and the last different one', () => {
    expect(trend([])).toBeNull();
    expect(trend([point(3, 129), point(2, 99), point(1, 99)])).toMatchObject({ current: { v: 99 }, previous: { v: 129 }, direction: 'down' });
    expect(trend([point(2, 99), point(1, 109)])).toMatchObject({ direction: 'up' });
    expect(trend([point(1, 99)])).toMatchObject({ previous: null, direction: 'same' });
  });

  it('sanitizes stored points (finite numbers, in time order)', () => {
    expect(sanitizeHistory([{ t: 1, v: 2, r: '$2' }, { t: 0, v: 3 }, { t: 5, v: Number.NaN }, null, { t: 6, v: 4 }])).toEqual([
      { t: 1, v: 2, r: '$2' },
      { t: 6, v: 4, r: '4' },
    ]);
    expect(sanitizeHistory('junk')).toEqual([]);
  });
});

describe('lowest in 30 days', () => {
  const history = [point(40, 89), point(25, 129), point(12, 99), point(2, 109)];

  it('finds the low in the window, ignoring older values', () => {
    expect(lowestSince(history, NOW - 30 * DAY_MS)).toMatchObject({ v: 99 });
    expect(newLow(history, 99, NOW)).toBeNull(); // equal isn't lower
    expect(newLow(history, 95, NOW)).toMatchObject({ previousLow: { v: 99 }, fullWindow: true });
  });

  it('says so when the history is shorter than the window', () => {
    const young = [point(6, 129), point(3, 119)];
    expect(newLow(young, 110, NOW)).toMatchObject({ previousLow: { v: 119 }, since: NOW - 6 * DAY_MS, fullWindow: false });
    expect(newLow([], 10, NOW)).toBeNull();
  });

  it('the "lowest" rule notifies on a new low only', () => {
    const rule = { mode: 'lowest' as const, keyword: '' };
    const alert = evaluateChange('$109.00', '$95.00', rule, { history, now: NOW })!;
    expect(alert).toMatchObject({ changed: true, summary: 'Lowest in 30 days: $95.00 (was $99.00)' });
    const quiet = evaluateChange('$95.00', '$101.00', rule, { history, now: NOW })!;
    expect(quiet).toMatchObject({ changed: false, summary: 'Price changed: $95.00 → $101.00' });
    const young = evaluateChange('$119.00', '$110.00', rule, { history: [point(6, 129), point(3, 119)], now: NOW })!;
    expect(young.summary).toBe('Lowest since Sep 22: $110.00 (was $119.00)');
    expect(evaluateChange('$119.00', 'Sold out', rule, { history, now: NOW })!.changed).toBe(false);
  });
});

describe('chart', () => {
  const box = { width: 300, height: 100, top: 10, right: 10, bottom: 20, left: 40 };

  it('places time left to right and values bottom to top, as a step line', () => {
    const geometry = chartGeometry([point(3, 129), point(2, 99), point(1, 109)], box)!;
    expect(geometry.points.map((p) => [p.x, p.y])).toEqual([
      [40, 10],
      [165, 80],
      [290, 56.7],
    ]);
    expect(geometry.line).toBe('M40 10H165V80H290V56.7');
    expect(geometry.area).toBe('M40 10H165V80H290V56.7V80H40Z');
    expect(geometry.min.point.v).toBe(99);
    expect(geometry.max.point.v).toBe(129);
    expect(geometry.last.point.v).toBe(109);
    expect(nearestPoint(geometry.points, 150)?.point.v).toBe(99);
  });

  it('draws a flat line through the middle when the value never changed', () => {
    const geometry = chartGeometry([point(3, 5), point(1, 5)], box)!;
    expect(geometry.points.map((p) => p.y)).toEqual([45, 45]);
    expect(chartGeometry([point(1, 5)], box)!.points[0]).toMatchObject({ x: 290, y: 45 });
    expect(chartGeometry([], box)).toBeNull();
  });

  it('free shows the last 7 days, Pro everything', () => {
    const points = [point(40, 1), point(20, 2), point(6, 3), point(1, 4)];
    expect(visibleHistory(points, true, NOW)).toHaveLength(4);
    expect(visibleHistory(points, false, NOW).map((p) => p.v)).toEqual([3, 4]);
    expect(visibleHistory([point(40, 1), point(20, 2)], false, NOW).map((p) => p.v)).toEqual([1, 2]);
    expect(visibleHistory([point(40, 1), point(1, 2)], false, NOW).map((p) => p.v)).toEqual([1, 2]);
  });
});
