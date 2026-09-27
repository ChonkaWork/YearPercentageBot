type Child = Node | string | null | undefined | false;

interface ElementOptions {
  class?: string;
  /** Always set as text, never parsed as HTML. */
  text?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

/**
 * Tiny DOM builder. Page and user content only ever goes through `text`/text nodes,
 * so it can't inject markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) element.setAttribute(name, value);
  for (const [type, listener] of Object.entries(options.on ?? {})) {
    element.addEventListener(type, listener as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = /<(path|circle|rect|ellipse|line|polyline|polygon)\b([^>]*?)\/?>/g;
const ATTRIBUTES = /([a-zA-Z][\w:-]*)="([^"]*)"/g;
const ALLOWED = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points', 'fill-rule', 'clip-rule', 'transform']);

export interface IconShape {
  tag: string;
  attrs: [string, string][];
}

/**
 * Reads a Bootstrap Icons SVG (bundled, trusted source) into shapes without any HTML parsing,
 * so icons work under strict page CSPs and Trusted Types.
 */
export function parseIcon(source: string): { viewBox: string; shapes: IconShape[] } {
  const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1] ?? '0 0 16 16';
  const shapes: IconShape[] = [];
  for (const [, tag, attributes] of source.matchAll(SHAPES)) {
    const attrs: [string, string][] = [];
    for (const [, name, value] of (attributes ?? '').matchAll(ATTRIBUTES)) {
      if (name && ALLOWED.has(name)) attrs.push([name, value ?? '']);
    }
    shapes.push({ tag: tag!, attrs });
  }
  return { viewBox, shapes };
}

const cache = new Map<string, ReturnType<typeof parseIcon>>();

/** Inline icon; decorative (aria-hidden) unless a label is given. */
export function icon(source: string, options: { size?: number; class?: string; label?: string } = {}): SVGSVGElement {
  let parsed = cache.get(source);
  if (!parsed) {
    parsed = parseIcon(source);
    cache.set(source, parsed);
  }
  const size = String(options.size ?? 16);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', parsed.viewBox);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('class', `bi${options.class ? ` ${options.class}` : ''}`);
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.setAttribute('focusable', 'false');
  for (const shape of parsed.shapes) {
    const element = document.createElementNS(SVG_NS, shape.tag);
    for (const [name, value] of shape.attrs) element.setAttribute(name, value);
    svg.append(element);
  }
  return svg;
}

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
