/**
 * The suggestion list under the caret: the snippets an abbreviation being typed could be.
 * It never takes focus (the user keeps typing in the field); the content script forwards
 * ↑/↓, Tab/Enter and Esc to it. A click picks an item without moving focus either.
 *
 * Lives in a closed shadow root appended to <html> (see host.ts). Focus stays in the page's
 * field, whose attributes we don't touch, and ARIA references can't cross into a closed shadow
 * root, so besides role=listbox/option and aria-activedescendant a polite live region inside
 * the list announces the highlighted snippet to screen readers.
 */

import type { PreviewPart } from '../core/preview';
import { renderPreview } from '../ui/preview';
import { createHost } from './host';

export interface SuggestionView {
  abbreviation: string;
  label: string;
  parts: PreviewPart[];
  /** Plain-text version of `parts`, for the announcement. */
  plain: string;
}

export interface SuggestionsOptions {
  /** The text being typed, e.g. `;me`. */
  query: string;
  items: readonly SuggestionView[];
  /** Which item is highlighted. */
  active: number;
  /** Where the query starts, in viewport coordinates. */
  anchor: DOMRect;
  onPick: (index: number) => void;
}

interface Open {
  host: HTMLElement;
  panel: HTMLDivElement;
  list: HTMLUListElement;
  status: HTMLDivElement;
  options: SuggestionsOptions;
  active: number;
}

let current: Open | null = null;
let sequence = 0;

export function suggestionsHost(): HTMLElement | null {
  return current?.host ?? null;
}

export function isOpen(): boolean {
  return current !== null;
}

export function activeIndex(): number {
  return current?.active ?? -1;
}

export function closeSuggestions(): void {
  current?.host.remove();
  current = null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function create(): Open {
  const { host, root } = createHost('snippets-suggest');
  const id = `snippets-suggest-${++sequence}`;
  const panel = el('div', 'suggest');
  const list = el('ul', 'suggest-list');
  list.id = id;
  list.setAttribute('role', 'listbox');
  const status = el('div', 'visually-hidden');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const foot = el('div', 'suggest-foot');
  foot.append(el('span', 'fill-kbd', '↑↓'), ' choose · ', el('span', 'fill-kbd', 'Tab'), ' or ', el('span', 'fill-kbd', 'Enter'), ' inserts · ', el('span', 'fill-kbd', 'Esc'), ' closes');
  panel.append(list, foot, status);
  root.append(panel);

  // Clicks must not take focus away from the field the user is typing in, and the page
  // doesn't need to hear about them.
  root.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  for (const type of ['pointerdown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu'] as const) {
    root.addEventListener(type, (event) => event.stopPropagation());
  }
  list.addEventListener('click', (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>('[role="option"]');
    const index = Number(item?.dataset.index);
    if (item && Number.isInteger(index)) current?.options.onPick(index);
  });
  list.addEventListener('mousemove', (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>('[role="option"]');
    const index = Number(item?.dataset.index);
    if (item && Number.isInteger(index) && index !== current?.active) setActive(index, false);
  });

  document.documentElement.append(host);
  return { host, panel, list, status, options: undefined as unknown as SuggestionsOptions, active: 0 };
}

function renderItem(view: SuggestionView, index: number, idPrefix: string): HTMLLIElement {
  const item = el('li', 'suggest-item');
  item.id = `${idPrefix}-${index}`;
  item.dataset.index = String(index);
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', 'false');
  const body = el('span', 'suggest-body');
  const title = el('span', 'suggest-title');
  if (view.label) title.textContent = view.label;
  else title.append(...renderPreview(view.parts));
  body.append(title);
  if (view.label) {
    const preview = el('span', 'suggest-preview');
    preview.append(...renderPreview(view.parts));
    body.append(preview);
  }
  item.append(el('span', 'suggest-abbr', view.abbreviation), body);
  item.setAttribute('aria-label', `${view.abbreviation}, ${view.label || view.plain}`);
  return item;
}

/** Opens the list or updates the open one (same anchor: it doesn't jump while typing). */
export function showSuggestions(options: SuggestionsOptions): void {
  const open = current ?? (current = create());
  open.options = options;
  const idPrefix = open.list.id;
  open.list.setAttribute('aria-label', `Snippets for ${options.query}`);
  open.list.replaceChildren(...options.items.map((view, index) => renderItem(view, index, idPrefix)));
  if (__E2E__) open.host.dataset.query = options.query;
  setActive(Math.min(Math.max(0, options.active), options.items.length - 1), true);
  reposition(options.anchor);
}

const GAP = 6;
const MARGIN = 8;

/**
 * Under the caret, or above it when there is more room there. The list never covers the line
 * being typed: when neither side has room for all of it, it gets shorter (and scrolls).
 */
export function reposition(anchor: DOMRect): void {
  if (!current) return;
  current.options.anchor = anchor;
  const { host, panel, list } = current;
  list.style.maxHeight = '';
  const height = panel.offsetHeight;
  const below = window.innerHeight - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const side = height <= below || below >= above ? 'below' : 'above';
  const room = side === 'below' ? below : above;
  if (height > room) list.style.maxHeight = `${Math.max(48, list.offsetHeight - (height - room))}px`;
  const top = side === 'below' ? anchor.bottom + GAP : anchor.top - GAP - panel.offsetHeight;
  const left = Math.min(Math.max(MARGIN, anchor.left), Math.max(MARGIN, window.innerWidth - panel.offsetWidth - MARGIN));
  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(Math.max(MARGIN, top))}px`;
  panel.classList.toggle('is-above', side === 'above');
}

/** Moves the highlight by `delta` rows (wrapping). */
export function moveActive(delta: number): void {
  if (!current) return;
  const count = current.options.items.length;
  if (count === 0) return;
  setActive((current.active + delta + count) % count, true);
}

function setActive(index: number, scroll: boolean): void {
  if (!current) return;
  current.active = index;
  let activeItem: HTMLElement | null = null;
  for (const item of current.list.children) {
    const selected = Number((item as HTMLElement).dataset.index) === index;
    item.setAttribute('aria-selected', String(selected));
    item.classList.toggle('active', selected);
    if (selected) activeItem = item as HTMLElement;
  }
  if (!activeItem) {
    current.list.removeAttribute('aria-activedescendant');
    return;
  }
  current.list.setAttribute('aria-activedescendant', activeItem.id);
  // Scroll only the list (scrollIntoView could scroll the page).
  if (scroll) {
    const list = current.list;
    if (activeItem.offsetTop < list.scrollTop) list.scrollTop = activeItem.offsetTop - 4;
    else if (activeItem.offsetTop + activeItem.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = activeItem.offsetTop + activeItem.offsetHeight - list.clientHeight + 4;
    }
  }
  const view = current.options.items[index];
  const count = current.options.items.length;
  if (view) {
    current.status.textContent = `${view.abbreviation}, ${view.label || view.plain}. ${index + 1} of ${count} snippets. Tab inserts, Escape closes.`;
  }
}
