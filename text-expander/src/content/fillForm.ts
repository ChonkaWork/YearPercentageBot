/**
 * The Pro fill-in form: a small panel next to the caret that asks for the values of a
 * snippet's `{input:Name}` fields. Keyboard-first: the first field is focused and selected,
 * Tab/Shift+Tab move between fields (and wrap), Enter inserts, Esc cancels. Clicking outside
 * also cancels.
 *
 * It lives in a closed shadow root appended to <html> (outside <body>, which may itself be an
 * editor), styled through adoptedStyleSheets. Key events stay inside: the page never sees what
 * is typed into the form.
 */

import css from '../styles/inpage.scss?inline';
import type { FillField } from '../core/variables';

export interface FillFormOptions {
  abbreviation: string;
  fields: readonly FillField[];
  /** Where the caret is, in viewport coordinates. */
  anchor: DOMRect;
  onSubmit: (values: Record<string, string>) => void;
  /** `refocus` is false when the user clicked or tabbed somewhere else on purpose. */
  onCancel: (refocus: boolean) => void;
}

let sheet: CSSStyleSheet | null = null;
function styles(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  }
  return sheet;
}

let current: { host: HTMLElement; close: () => void } | null = null;

/** The open form's host element (events from inside it are ours, not typing in the page). */
export function fillFormHost(): HTMLElement | null {
  return current?.host ?? null;
}

export function closeFillForm(): void {
  current?.close();
}

function createHost(): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement('snippets-fill');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 0; top: 0;';
  // Open only in the test build, so the e2e test can look inside.
  const root = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  root.adoptedStyleSheets = [styles()];
  return { host, root };
}

const GAP = 6;
const MARGIN = 8;

function place(host: HTMLElement, panel: HTMLElement, anchor: DOMRect): void {
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
  const left = Math.min(Math.max(MARGIN, anchor.left), maxLeft);
  let top = anchor.bottom + GAP;
  if (top + height > window.innerHeight - MARGIN && anchor.top - GAP - height >= MARGIN) top = anchor.top - GAP - height;
  top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));
  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function openFillForm(options: FillFormOptions): void {
  closeFillForm();
  const { host, root } = createHost();

  const form = el('form', 'fill');
  form.setAttribute('aria-label', `Fill in ${options.abbreviation}`);
  form.noValidate = true;
  const head = el('div', 'fill-head');
  head.append(el('span', 'fill-abbr', options.abbreviation), el('span', 'fill-label', 'Fill in'));
  form.append(head);

  const inputs = options.fields.map((field, index) => {
    const row = el('label', 'fill-row');
    const label = el('span', 'fill-label', field.name);
    const input = el('input', 'fill-input');
    input.type = 'text';
    input.value = field.defaultValue;
    input.name = `field-${index}`;
    input.autocomplete = 'off';
    input.spellcheck = true;
    input.dataset.field = field.name;
    row.append(label, input);
    form.append(row);
    return input;
  });

  const foot = el('div', 'fill-foot');
  const hint = el('span', 'fill-hint');
  hint.append(el('span', 'fill-kbd', 'Enter'), ' inserts · ', el('span', 'fill-kbd', 'Esc'), ' cancels');
  const cancel = el('button', 'fill-btn', 'Cancel');
  cancel.type = 'button';
  const insert = el('button', 'fill-btn fill-btn-primary', 'Insert');
  insert.type = 'submit';
  foot.append(hint, cancel, insert);
  form.append(foot);
  root.append(form);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('pointerdown', onOutsidePointer, true);
    window.removeEventListener('resize', onViewportChange);
    host.remove();
    if (current?.host === host) current = null;
  };
  const cancelForm = (refocus: boolean) => {
    if (closed) return;
    close();
    options.onCancel(refocus);
  };
  const submit = () => {
    if (closed) return;
    const values: Record<string, string> = {};
    inputs.forEach((input, index) => {
      const field = options.fields[index];
      if (field) values[field.name] = input.value;
    });
    close();
    options.onSubmit(values);
  };

  const focusables = (): HTMLElement[] => [...inputs, cancel, insert];
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  cancel.addEventListener('click', () => cancelForm(true));
  form.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelForm(true);
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Tab') {
      // Keep Tab inside the form: from the last control back to the first, and the reverse.
      const list = focusables();
      const index = list.indexOf(root.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? list[list.length - 1] : undefined) : index === list.length - 1 ? list[0] : undefined;
      if (next) {
        event.preventDefault();
        next.focus();
        if (next instanceof HTMLInputElement) next.select();
      }
    }
  });
  // What happens in the form stays in the form: the page's own key handlers (shortcuts, chat
  // "typing" indicators, keyloggers) don't see it.
  for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut'] as const) {
    root.addEventListener(type, (event) => event.stopPropagation());
  }
  // Focus leaving for something else in the page (not a window switch) means "never mind".
  form.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (!closed && document.hasFocus() && !root.activeElement) cancelForm(false);
    }, 0);
  });
  const onOutsidePointer = (event: Event) => {
    if (!event.composedPath().includes(host)) cancelForm(false);
  };
  const onViewportChange = () => place(host, form, options.anchor);
  window.addEventListener('pointerdown', onOutsidePointer, true);
  window.addEventListener('resize', onViewportChange);

  document.documentElement.append(host);
  current = { host, close };
  place(host, form, options.anchor);
  const first = inputs[0];
  first?.focus({ preventScroll: true });
  first?.select();
  if (__E2E__) host.dataset.fields = options.fields.map((field) => field.name).join('|');
}

// --- Caret position ---------------------------------------------------------------------

const MIRRORED = [
  'boxSizing',
  'width',
  'height',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'direction',
] as const;

/**
 * Viewport rectangle of the caret at `position` in an input or textarea. Inputs have no API
 * for it, so a hidden copy with the same box and font is laid out inside our own shadow root
 * (the page's DOM is never touched).
 */
export function fieldCaretRect(element: HTMLInputElement | HTMLTextAreaElement, position: number): DOMRect {
  const box = element.getBoundingClientRect();
  try {
    const { host, root } = createHost();
    const style = getComputedStyle(element);
    const mirror = document.createElement('div');
    mirror.className = 'caret-mirror';
    for (const property of MIRRORED) mirror.style[property] = style[property];
    mirror.style.left = `${box.left}px`;
    mirror.style.top = `${box.top}px`;
    const textarea = element instanceof HTMLTextAreaElement;
    mirror.style.whiteSpace = textarea ? 'pre-wrap' : 'pre';
    mirror.style.overflowWrap = textarea ? 'break-word' : 'normal';
    mirror.textContent = element.value.slice(0, position);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.append(marker);
    root.append(mirror);
    document.documentElement.append(host);
    const rect = marker.getBoundingClientRect();
    host.remove();
    const left = Math.min(Math.max(rect.left - element.scrollLeft, box.left), box.right);
    const top = Math.min(Math.max(rect.top - element.scrollTop, box.top), box.bottom - rect.height);
    return new DOMRect(left, top, 1, rect.height || box.height);
  } catch {
    return new DOMRect(box.left, box.bottom - 1, 1, 1);
  }
}

/** Viewport rectangle of a collapsed range in a rich editor, falling back to the editor's box. */
export function rangeCaretRect(range: Range, element: HTMLElement): DOMRect {
  const rect = range.getBoundingClientRect();
  if (rect.height > 0 || rect.left > 0 || rect.top > 0) return rect;
  const first = range.getClientRects()[0];
  if (first) return first;
  const box = element.getBoundingClientRect();
  return new DOMRect(box.left, box.top, 1, Math.min(box.height, 20));
}
