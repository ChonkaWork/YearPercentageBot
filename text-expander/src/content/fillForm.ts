/**
 * The Pro fill-in form: a small panel next to the caret that asks for the values of a
 * snippet's `{input:Name}` fields and `{choice:Name=A|B}` dropdowns. Keyboard-first: the first
 * field is focused and selected, Tab/Shift+Tab move between fields (and wrap), Enter inserts,
 * Esc cancels. Clicking outside also cancels.
 *
 * It lives in a closed shadow root appended to <html> (see host.ts). Key events stay inside:
 * the page never sees what is typed into the form.
 */

import { isChoice, type FillField } from '../core/variables';
import { createHost, placeNear } from './host';

export interface FillFormOptions {
  abbreviation: string;
  fields: readonly FillField[];
  /** Where the caret is, in viewport coordinates. */
  anchor: DOMRect;
  onSubmit: (values: Record<string, string>) => void;
  /** `refocus` is false when the user clicked or tabbed somewhere else on purpose. */
  onCancel: (refocus: boolean) => void;
}

let current: { host: HTMLElement; close: () => void } | null = null;

/** The open form's host element (events from inside it are ours, not typing in the page). */
export function fillFormHost(): HTMLElement | null {
  return current?.host ?? null;
}

export function closeFillForm(): void {
  current?.close();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function openFillForm(options: FillFormOptions): void {
  closeFillForm();
  const { host, root } = createHost('snippets-fill');

  const form = el('form', 'fill');
  form.setAttribute('aria-label', `Fill in ${options.abbreviation}`);
  form.noValidate = true;
  const head = el('div', 'fill-head');
  head.append(el('span', 'fill-abbr', options.abbreviation), el('span', 'fill-label', 'Fill in'));
  form.append(head);

  const inputs = options.fields.map((field, index): HTMLInputElement | HTMLSelectElement => {
    const row = el('label', 'fill-row');
    const label = el('span', 'fill-label', field.name);
    let control: HTMLInputElement | HTMLSelectElement;
    if (isChoice(field)) {
      control = el('select', 'fill-input fill-select');
      for (const option of field.options) control.append(new Option(option, option));
      control.value = field.defaultValue;
    } else {
      control = el('input', 'fill-input');
      control.type = 'text';
      control.value = field.defaultValue;
      control.autocomplete = 'off';
      control.spellcheck = true;
    }
    control.name = `field-${index}`;
    control.dataset.field = field.name;
    row.append(label, control);
    form.append(row);
    return control;
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
  const onViewportChange = () => placeNear(host, form, options.anchor);
  window.addEventListener('pointerdown', onOutsidePointer, true);
  window.addEventListener('resize', onViewportChange);

  document.documentElement.append(host);
  current = { host, close };
  placeNear(host, form, options.anchor);
  const first = inputs[0];
  first?.focus({ preventScroll: true });
  if (first instanceof HTMLInputElement) first.select();
  if (__E2E__) host.dataset.fields = options.fields.map((field) => field.name).join('|');
}
