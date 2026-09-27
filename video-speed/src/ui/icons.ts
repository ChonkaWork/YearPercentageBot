import { parseIcon, type IconData } from './iconData';

/**
 * Bootstrap Icons, imported per use as SVG text (esbuild's text loader), e.g.
 *   import plusLg from 'bootstrap-icons/icons/plus-lg.svg';
 *   button.append(icon(plusLg));
 * and rebuilt as DOM nodes, so each bundle only carries the icons it uses.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const cache = new Map<string, IconData>();

export function icon(svgText: string, options: { size?: number; class?: string } = {}): SVGSVGElement {
  let data = cache.get(svgText);
  if (!data) {
    data = parseIcon(svgText);
    cache.set(svgText, data);
  }
  const size = String(options.size ?? 16);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', data.viewBox);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', options.class ? `bi ${options.class}` : 'bi');
  for (const node of data.nodes) {
    const element = document.createElementNS(SVG_NS, node.tag);
    for (const [attr, value] of Object.entries(node.attrs)) element.setAttribute(attr, value);
    svg.append(element);
  }
  return svg;
}
