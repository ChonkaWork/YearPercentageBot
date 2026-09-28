/**
 * Parses a Bootstrap Icons SVG file (bundled as text at build time) into plain data, so the
 * icon can be rebuilt with createElementNS. No markup is ever parsed by the browser, which
 * keeps pages with Trusted Types or strict CSP happy. Pure; unit-tested against the real files.
 */

export interface IconNode {
  tag: string;
  attrs: Record<string, string>;
}

export interface IconData {
  viewBox: string;
  nodes: IconNode[];
}

const SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon']);
const ATTRIBUTES = new Set([
  'd',
  'fill-rule',
  'clip-rule',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'width',
  'height',
  'points',
  'transform',
  'opacity',
]);

export function parseIcon(svg: string): IconData {
  const viewBox = /<svg\b[^>]*\bviewBox="([^"]*)"/.exec(svg)?.[1] ?? '0 0 16 16';
  const nodes: IconNode[] = [];
  for (const match of svg.matchAll(/<([a-z]+)\b([^>]*?)\/?>/g)) {
    const tag = match[1] ?? '';
    if (!SHAPES.has(tag)) continue;
    const attrs: Record<string, string> = {};
    for (const attr of (match[2] ?? '').matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      const name = attr[1] ?? '';
      if (ATTRIBUTES.has(name)) attrs[name] = attr[2] ?? '';
    }
    nodes.push({ tag, attrs });
  }
  return { viewBox, nodes };
}
