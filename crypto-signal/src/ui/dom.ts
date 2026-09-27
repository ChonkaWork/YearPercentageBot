type Child = Node | string | null | undefined | false;

interface ElementOptions {
  class?: string;
  /** Always set as text, never parsed as HTML. */
  text?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

/**
 * Tiny DOM builder. Data (prices, tickers, page text, API values) only ever goes through
 * `text`/text nodes, so nothing from outside can inject markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElementOptions = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [type, listener] of Object.entries(options.on ?? {})) element.addEventListener(type, listener as EventListener);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (SVGElement | null)[]): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  for (const child of children) if (child) element.append(child);
  return element;
}
