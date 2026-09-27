import { svg } from '../ui/dom';

/** The CryptoSignal mark: three rising gold candles on a dark tile. Same drawing as icons/icon.svg. */
export function logo(size = 22): SVGSVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 128 128', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    svg('rect', { width: 128, height: 128, rx: 28, fill: '#15191e' }),
    svg('rect', { x: 0.5, y: 0.5, width: 127, height: 127, rx: 27.5, fill: 'none', stroke: '#2b3139' }),
    svg('path', { d: 'M38 58v44M64 40v48M90 20v50', stroke: '#f0b90b', 'stroke-width': 6, 'stroke-linecap': 'round' }),
    svg('rect', { x: 28, y: 68, width: 20, height: 26, rx: 5, fill: '#f0b90b' }),
    svg('rect', { x: 54, y: 50, width: 20, height: 30, rx: 5, fill: '#f0b90b' }),
    svg('rect', { x: 80, y: 28, width: 20, height: 34, rx: 5, fill: '#f0b90b' }),
  );
}
