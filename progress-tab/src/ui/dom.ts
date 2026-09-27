type Child = Node | string | null | undefined | false;

interface ElementOptions {
  class?: string;
  /** Always set as text, never parsed as HTML. */
  text?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

/**
 * Tiny DOM builder. User content (countdown names) only ever goes through `text`/text nodes, so
 * it can't inject markup.
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

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

// Writes skip unchanged values, so a once-a-second tick only touches what really changed.

export function setText(element: Node, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

export function setAttr(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function setHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden !== hidden) element.hidden = hidden;
}

/** Message of anything thrown, for showing to the user. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'Unknown error';
}

/**
 * Makes `parent`'s children exactly `nodes`, in order, touching only what changed. The child
 * that holds keyboard focus is never moved (moving a node drops focus): the others are arranged
 * around it.
 */
export function placeChildren(parent: Element, nodes: readonly Element[]): void {
  const current = [...parent.children];
  if (current.length === nodes.length && current.every((node, index) => node === nodes[index])) return;
  const wanted = new Set<Element>(nodes);
  for (const child of current) if (!wanted.has(child)) child.remove();

  const active = document.activeElement;
  const anchor = nodes.find((node) => node.parentElement === parent && active !== null && node.contains(active));
  if (!anchor) {
    nodes.forEach((node, index) => {
      if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
    });
    return;
  }
  const at = nodes.indexOf(anchor);
  let next: Element = anchor;
  for (const node of nodes.slice(0, at).reverse()) {
    if (node.nextElementSibling !== next) parent.insertBefore(node, next);
    next = node;
  }
  let previous: Element = anchor;
  for (const node of nodes.slice(at + 1)) {
    if (previous.nextElementSibling !== node) parent.insertBefore(node, previous.nextElementSibling);
    previous = node;
  }
}
