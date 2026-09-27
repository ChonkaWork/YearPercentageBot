import { describe, expect, it } from 'vitest';
import { chartGeometry, nearestIndex } from '../src/core/chart';

const box = { width: 300, height: 100, padTop: 10, padRight: 10, padBottom: 10, padLeft: 10 };

describe('chartGeometry', () => {
  it('maps the series into the box, newest point at the right edge', () => {
    const geometry = chartGeometry({ close: [1, 2, 3, 2, 5], ema20: [null, null, 2, 2.2, 3], ema50: [null, null, null, null, null] }, box)!;
    expect(geometry.points).toHaveLength(5);
    expect(geometry.points[0]!.x).toBe(10);
    expect(geometry.last.x).toBe(290);
    // Highest close is drawn highest (smallest y).
    expect(geometry.high.value).toBe(5);
    expect(geometry.high.point.y).toBeLessThan(geometry.low.point.y);
    expect(geometry.price.startsWith('M10 ')).toBe(true);
    expect(geometry.price.match(/L/g)).toHaveLength(4);
    expect(geometry.ema20.startsWith('M150 ')).toBe(true);
    expect(geometry.ema50).toBe('');
    expect(geometry.area.endsWith('Z')).toBe(true);
    for (const point of geometry.points) {
      expect(point.y).toBeGreaterThanOrEqual(box.padTop);
      expect(point.y).toBeLessThanOrEqual(box.height - box.padBottom);
    }
  });

  it('draws a flat series as a centred line instead of dividing by zero', () => {
    const geometry = chartGeometry({ close: [7, 7, 7], ema20: [7, 7, 7], ema50: [7, 7, 7] }, box)!;
    expect(geometry.points.every((point) => point.y === 50)).toBe(true);
    expect(geometry.price).not.toMatch(/NaN|Infinity/);
  });

  it('breaks lines at gaps', () => {
    const geometry = chartGeometry({ close: [1, 2, 3, 4], ema20: [1, null, 3, 4], ema50: [null, null, null, null] }, box)!;
    expect(geometry.ema20.match(/M/g)).toHaveLength(2);
  });

  it('returns null without two finite prices', () => {
    expect(chartGeometry({ close: [1], ema20: [null], ema50: [null] }, box)).toBeNull();
    expect(chartGeometry({ close: [1, Number.NaN], ema20: [null, null], ema50: [null, null] }, box)).toBeNull();
  });

  it('finds the nearest candle for a pointer position', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    expect(nearestIndex(-5, points)).toBe(0);
    expect(nearestIndex(14, points)).toBe(1);
    expect(nearestIndex(16, points)).toBe(2);
    expect(nearestIndex(5, [])).toBe(-1);
  });
});
