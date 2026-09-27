import css from 'virtual:picker-css';
import { extractText, isHiddenElement } from '../core/extract';
import { MAX_SNAPSHOT_CHARS } from '../core/normalize';
import { describeElement, selectorCandidates } from '../core/selector';
import type { WatchDraft } from '../core/types';
import { hostLabel } from '../core/url';
import { isPickerStartMessage, type CreateResponse, type PickerStartMessage } from '../platform/messages';
import { h, icon } from '../ui/dom';
import { intervalPhrase, plural } from '../ui/format';
import { ICONS } from '../ui/icons';
import { optionsForm, type OptionsForm } from '../ui/optionsForm';

/**
 * Element picker, injected on demand into the top frame of the current tab. Highlights the
 * element under the pointer, picks on click, and lets the user adjust the choice (wider /
 * narrower) with buttons or the arrow keys before saving. Lives in a shadow root, so the
 * page's CSS can't touch it and it can't touch the page.
 */

const XHTML = 'http://www.w3.org/1999/xhtml';
const BLOCKED_POINTER_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'submit'] as const;
const KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const;
const DONE_CLOSE_MS = 5000;

type State = 'hover' | 'confirm' | 'saving' | 'done';

class Picker {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private highlight: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private bar: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private form: OptionsForm | null = null;
  private state: State = 'hover';
  private current: Element | null = null;
  private selected: Element | null = null;
  /** Elements left behind by "wider", so "narrower" can go back down the same path. */
  private trail: Element[] = [];
  private candidates: string[] = [];
  private liveText = '';
  private defaults: PickerStartMessage | null = null;
  private returnFocus: Element | null = null;
  private frame = 0;
  private closeTimer: number | undefined;

  start(message: PickerStartMessage): void {
    this.stop(false, false);
    this.defaults = message;
    this.returnFocus = document.activeElement;
    this.state = 'hover';
    this.mount();
    for (const type of BLOCKED_POINTER_EVENTS) window.addEventListener(type, this.onPointer, true);
    for (const type of KEY_EVENTS) window.addEventListener(type, this.onKey, true);
    document.addEventListener('mousemove', this.onMove, { capture: true, passive: true });
    window.addEventListener('scroll', this.onViewport, { capture: true, passive: true });
    window.addEventListener('resize', this.onViewport, { passive: true });
    this.bar?.focus({ preventScroll: true });
  }

  /** Removes everything. `notify` tells the service worker, which gives back unused site access. */
  stop(created: boolean, notify = true): void {
    if (!this.host) return;
    window.clearTimeout(this.closeTimer);
    cancelAnimationFrame(this.frame);
    for (const type of BLOCKED_POINTER_EVENTS) window.removeEventListener(type, this.onPointer, true);
    for (const type of KEY_EVENTS) window.removeEventListener(type, this.onKey, true);
    document.removeEventListener('mousemove', this.onMove, true);
    window.removeEventListener('scroll', this.onViewport, true);
    window.removeEventListener('resize', this.onViewport);
    this.host.remove();
    this.host = this.root = this.highlight = this.label = this.bar = this.card = null;
    this.form = null;
    this.current = this.selected = null;
    this.trail = [];
    if (this.returnFocus instanceof HTMLElement && this.returnFocus.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
    if (notify) {
      chrome.runtime.sendMessage({ type: 'pw/picker-closed', url: location.href, created }).catch(() => undefined);
    }
  }

  // --- DOM ------------------------------------------------------------------------------

  private mount(): void {
    const host = document.createElement('page-watch-picker');
    host.style.cssText =
      'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;';
    const shadow = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      shadow.append(h('style', { text: css }));
    }

    this.highlight = h('div', { class: 'pw-highlight', attrs: { hidden: '' } });
    this.label = h('div', { class: 'pw-label', attrs: { hidden: '' } });
    const cancel = h(
      'button',
      { class: 'btn btn-sm btn-outline-secondary', attrs: { type: 'button' }, on: { click: () => this.stop(false) } },
      'Cancel',
    );
    this.bar = h(
      'div',
      { class: 'pw-bar', attrs: { role: 'dialog', 'aria-label': 'Page Watch element picker', tabindex: '-1' } },
      h('span', { class: 'pw-brand' }, h('span', { class: 'pw-mark' }, icon(ICONS.bell, { size: 12 })), 'Page Watch'),
      h('span', { class: 'pw-instruction', text: 'Click the part of the page to watch' }),
      h(
        'span',
        { class: 'pw-hints', attrs: { 'aria-label': 'Arrow up and down make it wider or narrower, Enter selects, Escape cancels' } },
        h('span', {}, h('kbd', { text: '↑' }), ' ', h('kbd', { text: '↓' }), ' wider/narrower'),
        h('span', {}, h('kbd', { text: 'Enter' }), ' select'),
        h('span', {}, h('kbd', { text: 'Esc' }), ' cancel'),
      ),
      cancel,
    );
    this.root = h('div', { class: 'pw-root' }, this.highlight, this.label, this.bar);
    shadow.append(this.root);
    // Keystrokes typed in the picker never reach the page's shortcuts.
    for (const type of KEY_EVENTS) this.root.addEventListener(type, (event) => event.stopPropagation());
    document.documentElement.append(host);
    this.host = host;
  }

  private isOwn(event: Event): boolean {
    return this.host !== null && event.composedPath().includes(this.host);
  }

  /** The element to use for a pointer target: not inside SVG, not hidden or text-less by nature. */
  private pickable(target: EventTarget | null): Element | null {
    let element = target instanceof Element ? target : null;
    while (element && (element.namespaceURI !== XHTML || isHiddenElement(element))) element = element.parentElement;
    if (!element || element === document.documentElement) return document.body;
    return element;
  }

  // --- Events -------------------------------------------------------------------------

  private readonly onMove = (event: MouseEvent): void => {
    if (this.state !== 'hover' || this.isOwn(event)) return;
    const element = this.pickable(event.target);
    if (element && element !== this.current) {
      this.current = element;
      this.trail = [];
      this.draw();
    }
    if (this.bar) {
      if (event.clientY < 90) this.bar.classList.add('is-bottom');
      else if (event.clientY > window.innerHeight - 90) this.bar.classList.remove('is-bottom');
    }
  };

  private readonly onPointer = (event: Event): void => {
    if (this.isOwn(event)) return;
    // The page must not react (links, buttons, forms) while picking.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click' || (this.state !== 'hover' && this.state !== 'confirm')) return;
    const element = this.pickable(event.target);
    if (element) this.select(element);
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    const own = this.isOwn(event);
    if (!own) {
      if (event.key === 'Tab') return;
      // Page shortcuts must not fire while picking.
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (event.type !== 'keydown') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.stop(this.state === 'done');
      return;
    }
    // In the card, its own controls handle keys; on the bar, its Cancel button handles Enter/Space.
    if (this.state !== 'hover') return;
    if (own && event.composedPath()[0] instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) event.preventDefault();
    if (!this.current && event.key.startsWith('Arrow')) {
      this.current = this.pickable(document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2));
      this.draw();
      return;
    }
    switch (event.key) {
      case 'ArrowUp':
        this.current = this.wider(this.current);
        break;
      case 'ArrowDown':
        this.current = this.narrower(this.current);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        this.current = this.sibling(this.current, event.key === 'ArrowRight');
        break;
      case 'Enter':
      case ' ':
        if (this.current) this.select(this.current);
        return;
      default:
        return;
    }
    this.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.draw();
  };

  private readonly onViewport = (): void => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  };

  // --- Navigation -------------------------------------------------------------------------

  private wider(element: Element | null): Element | null {
    const parent = element?.parentElement;
    if (!element || !parent || parent === document.documentElement) return element;
    this.trail.push(element);
    return parent;
  }

  private narrower(element: Element | null): Element | null {
    if (!element) return element;
    const back = this.trail.at(-1);
    if (back && element.contains(back)) return this.trail.pop()!;
    return this.firstUsefulChild(element) ?? element;
  }

  private firstUsefulChild(element: Element): Element | null {
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
      if (child.namespaceURI !== XHTML || isHiddenElement(child)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && child.textContent?.trim()) return child;
    }
    return null;
  }

  private sibling(element: Element | null, next: boolean): Element | null {
    if (!element) return element;
    for (let node = next ? element.nextElementSibling : element.previousElementSibling; node; node = next ? node.nextElementSibling : node.previousElementSibling) {
      if (node.namespaceURI === XHTML && !isHiddenElement(node) && node.getBoundingClientRect().height > 0) {
        this.trail = [];
        return node;
      }
    }
    return element;
  }

  // --- Drawing ----------------------------------------------------------------------------

  private draw(): void {
    const target = this.state === 'hover' ? this.current : this.selected;
    const { highlight, label } = this;
    if (!highlight || !label) return;
    if (!target || !target.isConnected) {
      highlight.hidden = label.hidden = true;
      return;
    }
    const rect = target.getBoundingClientRect();
    highlight.hidden = label.hidden = false;
    highlight.classList.toggle('is-selected', this.state !== 'hover');
    Object.assign(highlight.style, {
      top: `${rect.top - 2}px`,
      left: `${rect.left - 2}px`,
      width: `${rect.width + 4}px`,
      height: `${rect.height + 4}px`,
    });
    label.textContent = `${describeElement(target)}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    const labelTop = rect.top > 26 ? rect.top - 24 : Math.min(rect.bottom + 4, window.innerHeight - 24);
    label.style.top = `${Math.max(2, labelTop)}px`;
    label.style.left = `${Math.min(Math.max(2, rect.left - 2), Math.max(2, window.innerWidth - label.offsetWidth - 4))}px`;
    if (this.card) {
      // Keep the card off the element it describes.
      const onRight = rect.right > window.innerWidth - 380 && rect.left > 380;
      this.card.classList.toggle('is-left', onRight);
    }
  }

  // --- Confirmation card ---------------------------------------------------------------------

  private select(element: Element): void {
    if (this.state === 'saving' || this.state === 'done') return;
    this.selected = element;
    this.state = 'confirm';
    this.candidates = selectorCandidates(element);
    this.liveText = extractText(element).slice(0, MAX_SNAPSHOT_CHARS);
    if (this.bar) this.bar.hidden = true;
    this.renderCard();
    this.draw();
  }

  private adjust(direction: 'wider' | 'narrower'): void {
    if (!this.selected || this.state !== 'confirm') return;
    const next = direction === 'wider' ? this.wider(this.selected) : this.narrower(this.selected);
    if (next && next !== this.selected) {
      this.selected = next;
      this.candidates = selectorCandidates(next);
      this.liveText = extractText(next).slice(0, MAX_SNAPSHOT_CHARS);
      this.renderCard(direction);
      this.draw();
    }
  }

  private renderCard(focus: 'name' | 'wider' | 'narrower' | 'none' = 'name', error?: string): void {
    if (!this.root || !this.selected || !this.defaults) return;
    this.form ??= optionsForm('pw', {
      name: this.defaults.title.trim() || hostLabel(location.href),
      intervalMinutes: this.defaults.intervalMinutes,
      mode: /\d/.test(this.liveText) && this.liveText.length < 80 ? 'number' : 'text',
      keyword: '',
    });
    const form = this.form;

    const wider = h(
      'button',
      { class: 'btn btn-outline-secondary', attrs: { type: 'button', title: 'Select the surrounding element (↑)' }, on: { click: () => this.adjust('wider') } },
      icon(ICONS.wider),
      'Wider',
    );
    const narrower = h(
      'button',
      { class: 'btn btn-outline-secondary', attrs: { type: 'button', title: 'Select a smaller element inside (↓)' }, on: { click: () => this.adjust('narrower') } },
      icon(ICONS.narrower),
      'Narrower',
    );
    wider.disabled = !this.selected.parentElement || this.selected.parentElement === document.documentElement;
    narrower.disabled = !this.trail.length && !this.firstUsefulChild(this.selected);

    const lines = this.liveText ? this.liveText.split('\n').length : 0;
    const preview = this.liveText
      ? h('div', { class: 'pw-preview', text: this.liveText, attrs: { 'aria-label': 'Text that will be watched', tabindex: '0' } })
      : h('div', { class: 'alert alert-warning py-2 px-2 my-2 small', text: 'This element has no text to watch. Use Wider to include more of the page.' });

    const save = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'button' } });
    const busy = this.state === 'saving';
    if (busy) save.append(h('span', { class: 'spinner-border spinner-border-sm', attrs: { 'aria-hidden': 'true' } }), 'Checking the page…');
    else save.append(icon(ICONS.bell), 'Watch this');
    save.disabled = busy || !this.liveText;
    save.addEventListener('click', () => void this.save());
    form.setDisabled(busy);
    wider.disabled ||= busy;
    narrower.disabled ||= busy;

    const status = h('div', { attrs: { 'aria-live': 'polite' } });
    if (error) {
      status.append(
        h('div', { class: 'alert alert-danger small d-flex gap-2 mt-2 mb-0', attrs: { role: 'alert' } }, icon(ICONS.danger, { class: 'mt-1' }), h('div', { text: error })),
      );
    }

    const body = h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2 mb-1' },
        h('span', { class: 'section-label mb-0 me-auto', text: 'Watch this part' }),
        h('div', { class: 'btn-group btn-group-sm', attrs: { role: 'group', 'aria-label': 'Adjust the selection' } }, wider, narrower),
      ),
      h('code', {
        class: 'pw-tag',
        text: this.candidates[0] ?? describeElement(this.selected),
        attrs: { title: 'CSS selector of the picked element' },
      }),
      preview,
      this.liveText ? h('div', { class: 'pw-meta mb-2', text: `${plural(this.liveText.length, 'character')} · ${plural(lines, 'line')}` }) : null,
      form.element,
      status,
    );
    body.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Enter' && target instanceof HTMLInputElement && target.type === 'text') {
        event.preventDefault();
        void this.save();
      }
    });

    const close = h('button', {
      class: 'btn-close ms-auto',
      attrs: { type: 'button', 'aria-label': 'Cancel' },
      on: { click: () => this.stop(false) },
    });
    const card = h(
      'div',
      { class: 'card pw-card', attrs: { role: 'dialog', 'aria-label': 'Page Watch: watch this element' } },
      h('div', { class: 'card-header' }, h('span', { class: 'pw-brand' }, h('span', { class: 'pw-mark' }, icon(ICONS.bell, { size: 12 })), 'Page Watch'), close),
      body,
      h(
        'div',
        { class: 'card-footer' },
        h('button', {
          class: 'btn btn-link btn-sm me-auto',
          text: 'Pick again',
          attrs: { type: 'button' },
          on: { click: () => this.pickAgain() },
        }),
        h('button', { class: 'btn btn-outline-secondary btn-sm', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => this.stop(false) } }),
        save,
      ),
    );
    if (this.card) this.card.replaceWith(card);
    else this.root.append(card);
    this.card = card;
    if (focus === 'wider' && !wider.disabled) wider.focus();
    else if (focus === 'narrower' && !narrower.disabled) narrower.focus();
    else if (focus === 'name' && !busy) form.focus();
  }

  private pickAgain(): void {
    this.card?.remove();
    this.card = null;
    this.selected = null;
    this.state = 'hover';
    if (this.bar) this.bar.hidden = false;
    this.bar?.focus({ preventScroll: true });
    this.draw();
  }

  private async save(): Promise<void> {
    if (this.state !== 'confirm' || !this.form || !this.selected) return;
    const problem = this.form.validate();
    if (problem) {
      this.renderCard('none', problem);
      return;
    }
    const values = this.form.values();
    const draft: WatchDraft = { url: location.href, selectors: this.candidates, liveText: this.liveText, ...values };
    this.state = 'saving';
    this.renderCard('none');
    let response: CreateResponse | undefined;
    try {
      response = (await chrome.runtime.sendMessage({ type: 'pw/create', draft })) as CreateResponse | undefined;
    } catch {
      response = { ok: false, code: 'unavailable', message: 'Page Watch was updated or restarted. Reload this page and try again.' };
    }
    if (!this.host) return; // Closed meanwhile.
    if (!response?.ok) {
      this.state = 'confirm';
      this.renderCard('none', response?.message ?? "Page Watch didn't respond. Please try again.");
      return;
    }
    this.showDone(response.watch.name, values);
  }

  private showDone(name: string, values: { intervalMinutes: PickerStartMessage['intervalMinutes']; mode: string; keyword: string }): void {
    this.state = 'done';
    const what =
      values.mode === 'number' ? 'a number or price in it changes' : values.mode === 'keyword' ? `“${values.keyword}” appears or disappears` : 'its text changes';
    const done = h('button', { class: 'btn btn-primary btn-sm', text: 'Done', attrs: { type: 'button' }, on: { click: () => this.stop(true) } });
    const card = h(
      'div',
      { class: 'card pw-card', attrs: { role: 'dialog', 'aria-label': 'Page Watch' } },
      h(
        'div',
        { class: 'card-body pw-done', attrs: { role: 'status' } },
        icon(ICONS.success, { size: 28, class: 'text-success mb-2' }),
        h('div', { class: 'fw-bold mb-1', text: `Watching “${name}”` }),
        h('p', {
          class: 'small text-body-secondary',
          text: `Page Watch checks it ${intervalPhrase(values.intervalMinutes)} and notifies you when ${what}.`,
        }),
        done,
      ),
    );
    this.card?.replaceWith(card);
    this.card = card;
    this.draw();
    done.focus();
    card.addEventListener('mouseenter', () => window.clearTimeout(this.closeTimer));
    this.closeTimer = window.setTimeout(() => this.stop(true), DONE_CLOSE_MS);
  }
}

// The script is injected each time the picker is opened; only the first run sets things up.
// After the extension is reloaded, an older copy is orphaned (its runtime is gone) and replaced.
interface Installed {
  picker: Picker;
  runtime: typeof chrome.runtime;
}

const GLOBAL_KEY = '__pageWatchPicker';
const scope = globalThis as unknown as Record<string, Installed | undefined>;

function isAlive(installed: Installed): boolean {
  try {
    return installed.runtime === chrome.runtime && Boolean(installed.runtime.id);
  } catch {
    return false;
  }
}

const installed = scope[GLOBAL_KEY];
if (!installed || !isAlive(installed)) {
  installed?.picker.stop(false, false);
  const picker = new Picker();
  scope[GLOBAL_KEY] = { picker, runtime: chrome.runtime };
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isPickerStartMessage(message)) return false;
    picker.start(message);
    sendResponse({ ok: true });
    return false;
  });
}
