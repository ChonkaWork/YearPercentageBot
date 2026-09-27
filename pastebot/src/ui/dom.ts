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

/** The Pastebot mark: a clipboard with a prompt caret. Same drawing as the toolbar icon. */
export function logo(size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 128 128');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const shapes: [string, Record<string, string>][] = [
    ['rect', { width: '128', height: '128', rx: '28', fill: '#e8590c' }],
    ['rect', { x: '30', y: '28', width: '68', height: '82', rx: '12', fill: '#fffdf8' }],
    ['rect', { x: '46', y: '17', width: '36', height: '21', rx: '7', fill: '#1c1917' }],
    ['path', { d: 'M47 60l14 12-14 12', fill: 'none', stroke: '#e8590c', 'stroke-width': '9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M69 86h14', fill: 'none', stroke: '#e8590c', 'stroke-width': '9', 'stroke-linecap': 'round' }],
  ];
  for (const [tag, attrs] of shapes) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    svg.append(element);
  }
  return svg;
}
