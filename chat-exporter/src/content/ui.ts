import { featureFor, type ExportAction } from '../export/actions';
import type { ButtonTarget } from '../sites/types';
import { copyText } from '../ui/clipboard';
import { h } from '../ui/dom';
import { downloadText } from '../ui/download';
import { icon, ICONS, type IconData } from '../ui/icons';
import css from '../styles/inpage.scss';

/**
 * The in-page UI: an "Export" button (in the site's header when the adapter finds a spot, a
 * small floating button otherwise), its menu, toasts, and "Select messages" (a checkbox beside
 * each message and a small bar). Everything lives in shadow roots, so the page's CSS can't touch
 * it and it can't touch the page: the checkboxes float above the messages instead of being
 * inserted into the site's DOM.
 */

export type UiAction = ExportAction | 'options' | 'select';

export interface MenuInfo {
  title: string;
  meta: string;
  /** Active export options, e.g. "Last 10 messages · No code blocks". */
  options?: string;
  /** Pro actions the current plan doesn't include: shown with a lock, they explain Pro instead. */
  locked: readonly UiAction[];
  /** Size of the hand-off prompt, e.g. "≈1.2k tokens". */
  handoff?: string;
  /** Shown instead of the actions when the conversation can't be read. */
  error?: string;
  /** Shown above the actions (e.g. a reply is still being written). */
  warning?: string;
}

/** Selected messages: indexes into the adapter's message list. Null: the whole conversation. */
export type Selection = readonly number[] | null;

export interface UiCallbacks {
  describe(selection: Selection): MenuInfo;
  /** Resolves true when something was exported (a selection is then closed). */
  run(action: UiAction, selection: Selection): Promise<boolean>;
}

/** A message the user can pick: its elements on the page and a name for screen readers. */
export interface SelectTarget {
  elements: readonly Element[];
  label: string;
}

type Tone = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  run(): void;
}

interface MenuItem {
  action: UiAction;
  label: string;
  icon: IconData;
  extension?: string;
  /** Shows a PRO badge. */
  pro: boolean;
}

const item = (action: UiAction, label: string, iconData: IconData, extension?: string): MenuItem => ({
  action,
  label,
  icon: iconData,
  ...(extension ? { extension } : {}),
  pro: action === 'options' || (action !== 'select' && featureFor(action) !== null),
});

const COPY_ITEM = item('copy', 'Copy as Markdown', ICONS.clipboard);
const HANDOFF_ITEM = item('handoff', 'Continue in another AI', ICONS.send);
const SELECT_ITEM = item('select', 'Select messages…', ICONS.check2Square);
const DOWNLOAD_ITEMS: MenuItem[] = [
  item('markdown', 'Markdown', ICONS.markdown, '.md'),
  item('text', 'Plain text', ICONS.fileEarmarkText, '.txt'),
  item('html', 'HTML', ICONS.filetypeHtml, '.html'),
  item('obsidian', 'Obsidian / Notion', ICONS.journalText, '.md'),
  item('json', 'JSON', ICONS.filetypeJson, '.json'),
  item('pdf', 'PDF (print view)', ICONS.filetypePdf),
];
const OPTIONS_ITEM = item('options', 'Export options', ICONS.sliders);

const TOAST_MS: Record<Tone, number> = { success: 3500, info: 6000, error: 8000 };

const HOST_STYLE = {
  inline: 'all: initial !important; display: inline-flex !important; align-items: center !important; margin: 0 6px !important; vertical-align: middle !important;',
  floating:
    'all: initial !important; position: fixed !important; top: 64px !important; right: 20px !important; z-index: 2147483646 !important; display: block !important;',
  layer:
    'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;',
};

interface Picker {
  targets: readonly SelectTarget[];
  /** The page's scrolling container of the messages: checkboxes and frames stay inside it (not over the site's header). */
  scroller: Element | null;
  selected: Set<number>;
  root: HTMLElement;
  picks: HTMLLabelElement[];
  frames: HTMLElement[];
  count: HTMLElement;
  exportButton: HTMLButtonElement;
  timer: number;
  frame: number;
}

export class ExportUi {
  private sheet: CSSStyleSheet | null = null;
  private buttonHost: HTMLElement | null = null;
  private buttonTheme: HTMLElement | null = null;
  private trigger: HTMLButtonElement | null = null;
  private layerHost: HTMLElement | null = null;
  private layerRoot: ShadowRoot | null = null;
  private layer: HTMLElement | null = null;
  private toasts: HTMLElement | null = null;
  private menu: HTMLElement | null = null;
  /** What the open menu is anchored to (the Export button or the selection bar's Export). */
  private menuAnchor: HTMLElement | null = null;
  private picker: Picker | null = null;
  private dark = false;
  private busy = false;

  constructor(private readonly callbacks: UiCallbacks) {}

  // --- Button -------------------------------------------------------------------------------

  /** Places the button at `target`, or floating when there is none. Cheap when nothing changed. */
  mount(target: ButtonTarget | null): void {
    const mode = target ? 'inline' : 'floating';
    const host = this.buttonHost ?? this.createButton();
    if (host.isConnected && host.dataset.mode === mode && (!target || isPlaced(host, target))) return;
    if (this.menuAnchor === this.trigger) this.closeMenu();
    host.dataset.mode = mode;
    host.style.cssText = HOST_STYLE[mode];
    this.buttonTheme?.classList.toggle('cx-floating', mode === 'floating');
    if (!target) document.documentElement.append(host);
    else if (target.position === 'before') target.element.before(host);
    else if (target.position === 'prepend') target.element.prepend(host);
    else target.element.append(host);
  }

  unmount(): void {
    this.closeMenu();
    this.stopSelection();
    this.buttonHost?.remove();
  }

  destroy(): void {
    this.unmount();
    this.layerHost?.remove();
    this.buttonHost = null;
    this.layerHost = null;
    this.layerRoot = null;
    this.layer = null;
    this.toasts = null;
  }

  setDark(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    for (const element of [this.buttonTheme, this.layer]) element?.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  }

  setWarning(warning: string | null): void {
    const trigger = this.trigger;
    if (!trigger) return;
    trigger.querySelector('.cx-warning-dot')?.remove();
    trigger.title = warning ?? 'Export this conversation';
    if (warning) trigger.append(h('span', { class: 'cx-warning-dot', attrs: { 'aria-hidden': 'true' } }));
  }

  private createButton(): HTMLElement {
    const host = document.createElement('chat-exporter-button');
    const root = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
    this.adoptStyles(root);
    const trigger = h(
      'button',
      {
        class: 'btn cx-trigger',
        attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Export this conversation' },
        on: { click: () => (this.menu && this.menuAnchor === this.trigger ? this.closeMenu(true) : this.openMenu(trigger)) },
      },
      icon(ICONS.download),
      h('span', { text: 'Export' }),
    );
    const theme = h('div', { class: 'cx-theme', attrs: { 'data-bs-theme': this.dark ? 'dark' : 'light' } }, trigger);
    isolateEvents(theme);
    root.append(theme);
    this.buttonHost = host;
    this.buttonTheme = theme;
    this.trigger = trigger;
    return host;
  }

  // --- Menu ---------------------------------------------------------------------------------

  private openMenu(anchor: HTMLElement): void {
    this.closeMenu();
    const layer = this.ensureLayer();
    // While messages are being picked, the menu exports just those.
    const selection = this.picker ? [...this.picker.selected].sort((a, b) => a - b) : null;
    const info = this.callbacks.describe(selection);
    const button = (entry: MenuItem): HTMLButtonElement => {
      const locked = info.locked.includes(entry.action);
      const side = entry.action === 'handoff' ? info.handoff : entry.extension;
      const element = h(
        'button',
        {
          class: `dropdown-item${locked ? ' cx-locked' : ''}`,
          attrs: { type: 'button', role: 'menuitem', 'data-action': entry.action },
          on: { click: () => void this.select(entry.action, selection) },
        },
        icon(entry.icon),
        h('span', { text: entry.label }),
        entry.pro ? proBadge(locked) : null,
        side ? h('span', { class: 'cx-ext', text: side }) : null,
      );
      // Exports need a readable conversation; the options page doesn't.
      element.disabled = Boolean(info.error) && entry.action !== 'options';
      return element;
    };
    const topItems = [button(COPY_ITEM), button(HANDOFF_ITEM), ...(selection ? [] : [button(SELECT_ITEM)])];
    const fileItems = DOWNLOAD_ITEMS.map(button);
    const optionsItem = selection ? null : button(OPTIONS_ITEM);
    const items = [...topItems, ...fileItems, ...(optionsItem ? [optionsItem] : [])];

    const menu = h(
      'div',
      { class: 'dropdown-menu show cx-menu', attrs: { role: 'menu', 'aria-label': selection ? 'Export selected messages' : 'Export conversation' } },
      h('h6', { class: 'dropdown-header', text: info.title, attrs: { title: info.title } }),
      h('div', { class: 'cx-menu-meta', text: info.meta }),
      info.options ? h('div', { class: 'cx-menu-options' }, icon(ICONS.sliders), h('span', { text: info.options })) : null,
      info.error
        ? h('div', { class: 'cx-menu-warning', attrs: { role: 'alert' } }, icon(ICONS.exclamationTriangleFill), h('span', { text: info.error }))
        : null,
      info.warning ? h('div', { class: 'cx-menu-warning' }, icon(ICONS.infoCircleFill), h('span', { text: info.warning })) : null,
      h('div', { class: 'dropdown-divider' }),
      ...topItems,
      h('h6', { class: 'dropdown-header cx-section', text: 'Download' }),
      ...fileItems,
      optionsItem ? h('div', { class: 'dropdown-divider' }) : null,
      optionsItem,
    );
    menu.addEventListener('keydown', (event) => this.onMenuKey(event, items));
    layer.append(menu);
    this.menu = menu;
    this.menuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    this.positionMenu();
    if (info.error) menu.tabIndex = -1;
    (items.find((entry) => !entry.disabled) ?? menu).focus();

    document.addEventListener('mousedown', this.onOutsidePointer, true);
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('scroll', this.onViewportChange, true);
  }

  closeMenu(restoreFocus = false): void {
    document.removeEventListener('mousedown', this.onOutsidePointer, true);
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    const anchor = this.menuAnchor;
    this.menuAnchor = null;
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }

  private positionMenu(): void {
    const menu = this.menu;
    const anchorElement = this.menuAnchor;
    if (!menu || !anchorElement) return;
    const anchor = anchorElement.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    const margin = 8;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    let top = anchor.bottom + 6;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, anchor.top - height - 6);
    const left = clamp(anchor.right - width, margin, viewportWidth - width - margin);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }

  private onMenuKey(event: KeyboardEvent, items: HTMLButtonElement[]): void {
    const enabled = items.filter((item) => !item.disabled);
    const index = enabled.indexOf(this.layerRoot?.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.closeMenu(true);
        return;
      case 'Tab':
        this.closeMenu(true);
        return;
      case 'ArrowDown':
        next = enabled[(index + 1) % enabled.length];
        break;
      case 'ArrowUp':
        next = enabled[(index - 1 + enabled.length) % enabled.length];
        break;
      case 'Home':
        next = enabled[0];
        break;
      case 'End':
        next = enabled[enabled.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    next?.focus();
  }

  private readonly onOutsidePointer = (event: MouseEvent): void => {
    const path = event.composedPath();
    if (this.menu && path.includes(this.menu)) return;
    if (this.menuAnchor && path.includes(this.menuAnchor)) return;
    if (this.buttonHost && path.includes(this.buttonHost) && this.menuAnchor === this.trigger) return;
    this.closeMenu();
  };

  private readonly onViewportChange = (): void => this.closeMenu();

  private async select(action: UiAction, selection: Selection): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.closeMenu(true);
    try {
      const exported = await this.callbacks.run(action, selection);
      if (exported && selection) this.endSelection();
    } finally {
      this.busy = false;
    }
  }

  // --- Select messages ----------------------------------------------------------------------

  get selecting(): boolean {
    return this.picker !== null;
  }

  /** Shows a checkbox beside each message and the "N selected · Export · Cancel" bar. */
  startSelection(targets: readonly SelectTarget[]): void {
    this.stopSelection();
    const layer = this.ensureLayer();
    const count = h('span', { class: 'cx-select-count', attrs: { 'aria-live': 'polite' } });
    const exportButton = h(
      'button',
      {
        class: 'btn btn-sm btn-primary cx-select-export',
        attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
        on: { click: () => (this.menu ? this.closeMenu(true) : this.openMenu(exportButton)) },
      },
      icon(ICONS.download),
      h('span', { text: 'Export' }),
    );
    const cancel = h('button', { class: 'btn btn-sm cx-select-cancel', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => this.endSelection() } });
    const bar = h('div', { class: 'cx-select-bar', attrs: { role: 'toolbar', 'aria-label': 'Selected messages' } }, icon(ICONS.check2Square, { class: 'cx-select-icon' }), count, exportButton, cancel);
    const root = h('div', { class: 'cx-select' }, h('div', { class: 'cx-select-picks' }), bar);
    layer.append(root);
    layer.classList.add('cx-selecting');
    this.picker = { targets: [], scroller: null, selected: new Set(), root, picks: [], frames: [], count, exportButton, timer: 0, frame: 0 };
    this.refreshSelection(targets);
    this.picker.timer = window.setInterval(this.schedulePositions, 500);
    window.addEventListener('scroll', this.schedulePositions, true);
    window.addEventListener('resize', this.schedulePositions);
    document.addEventListener('keydown', this.onSelectionKey, true);
    (this.picker.picks[0]?.querySelector('input') ?? exportButton).focus({ preventScroll: true });
  }

  /** Re-binds the checkboxes to the messages now on the page (the site may have re-rendered them). */
  refreshSelection(targets: readonly SelectTarget[]): void {
    const picker = this.picker;
    if (!picker) return;
    const layer = picker.root.querySelector('.cx-select-picks');
    if (picker.targets.length !== targets.length && layer) {
      for (const index of [...picker.selected]) if (index >= targets.length) picker.selected.delete(index);
      picker.frames = targets.map(() => h('div', { class: 'cx-pick-frame', attrs: { 'aria-hidden': 'true' } }));
      picker.picks = targets.map((target, index) => {
        const input = h('input', { attrs: { type: 'checkbox', 'aria-label': `Select ${target.label}`, 'data-index': String(index) } });
        input.checked = picker.selected.has(index);
        input.addEventListener('change', () => {
          if (input.checked) picker.selected.add(index);
          else picker.selected.delete(index);
          this.renderSelection();
        });
        return h('label', { class: 'cx-pick', attrs: { title: target.label } }, input);
      });
      layer.replaceChildren(...picker.frames, ...picker.picks);
    }
    picker.targets = targets;
    const first = targets[0]?.elements[0];
    if (first && !picker.scroller?.contains(first)) picker.scroller = scrollParent(first);
    this.renderSelection();
  }

  stopSelection(): void {
    const picker = this.picker;
    if (!picker) return;
    if (this.menuAnchor === picker.exportButton) this.closeMenu();
    window.clearInterval(picker.timer);
    cancelAnimationFrame(picker.frame);
    window.removeEventListener('scroll', this.schedulePositions, true);
    window.removeEventListener('resize', this.schedulePositions);
    document.removeEventListener('keydown', this.onSelectionKey, true);
    picker.root.remove();
    this.layer?.classList.remove('cx-selecting');
    this.picker = null;
  }

  private renderSelection(): void {
    const picker = this.picker;
    if (!picker) return;
    const count = picker.selected.size;
    picker.count.textContent = count ? `${count} selected` : 'Pick the messages to export';
    picker.exportButton.disabled = count === 0;
    picker.picks.forEach((pick, index) => pick.classList.toggle('checked', picker.selected.has(index)));
    this.positionPicks();
  }

  private readonly schedulePositions = (): void => {
    const picker = this.picker;
    if (!picker || picker.frame) return;
    picker.frame = requestAnimationFrame(() => {
      picker.frame = 0;
      this.positionPicks();
    });
  };

  /** Checkboxes at the top left of each visible message (sticky while a long one scrolls by). */
  private positionPicks(): void {
    const picker = this.picker;
    if (!picker) return;
    // Read every position first, then write, so the page is laid out once.
    const area = picker.scroller?.isConnected ? picker.scroller.getBoundingClientRect() : null;
    const top = Math.max(0, area?.top ?? 0);
    const bottom = Math.min(window.innerHeight, area?.bottom ?? window.innerHeight);
    const boxes = picker.targets.map((target) => unionRect(target.elements));
    boxes.forEach((box, index) => {
      const pick = picker.picks[index];
      const frame = picker.frames[index];
      if (!pick || !frame) return;
      const visible = box !== null && box.bottom > top + 8 && box.top < bottom - 8;
      pick.hidden = !visible;
      frame.hidden = !visible || !picker.selected.has(index);
      if (!visible || !box) return;
      const left = box.left - 38 >= 4 ? box.left - 38 : box.left + 6;
      const pickTop = Math.min(Math.max(box.top + 2, top + 8), box.bottom - 30);
      pick.style.transform = `translate(${Math.round(left)}px, ${Math.round(pickTop)}px)`;
      // The outline is cut where the message runs out of the visible area.
      const frameTop = Math.max(box.top - 6, top);
      const frameBottom = Math.min(box.bottom + 6, bottom);
      frame.classList.toggle('cx-cut-top', frameTop > box.top - 6);
      frame.classList.toggle('cx-cut-bottom', frameBottom < box.bottom + 6);
      frame.style.transform = `translate(${Math.round(box.left - 8)}px, ${Math.round(frameTop)}px)`;
      frame.style.width = `${Math.round(box.width + 16)}px`;
      frame.style.height = `${Math.max(0, Math.round(frameBottom - frameTop))}px`;
    });
  }

  private readonly onSelectionKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.picker || this.menu) return;
    event.preventDefault();
    event.stopPropagation();
    this.endSelection();
  };

  /** Closes the selection by the user's choice (Cancel, Escape, done) and gives focus back to the button. */
  private endSelection(): void {
    this.stopSelection();
    if (this.trigger?.isConnected) this.trigger.focus({ preventScroll: true });
  }

  // --- Output -------------------------------------------------------------------------------

  toast(tone: Tone, message: string, action?: ToastAction): void {
    this.ensureLayer();
    const container = this.toasts;
    if (!container) return;
    const toast = h(
      'div',
      { class: `toast show cx-toast ${tone}`, attrs: { role: tone === 'error' ? 'alert' : 'status', 'aria-live': tone === 'error' ? 'assertive' : 'polite' } },
      icon(tone === 'success' ? ICONS.checkCircleFill : tone === 'error' ? ICONS.exclamationTriangleFill : ICONS.infoCircleFill, { class: 'cx-toast-icon' }),
      h(
        'div',
        { class: 'cx-toast-text' },
        h('span', { text: message }),
        action
          ? h('button', {
              class: 'cx-toast-action',
              text: action.label,
              attrs: { type: 'button' },
              on: {
                click: () => {
                  toast.remove();
                  action.run();
                },
              },
            })
          : null,
      ),
    );
    const close = h(
      'button',
      { class: 'cx-toast-close', attrs: { type: 'button', 'aria-label': 'Dismiss' }, on: { click: () => toast.remove() } },
      icon(ICONS.xLg, { size: 12 }),
    );
    toast.append(close);
    // One message at a time: a new result replaces the previous one.
    container.replaceChildren(toast);
    window.setTimeout(() => toast.remove(), TOAST_MS[tone]);
  }

  download(filename: string, content: string, mime: string): void {
    this.ensureLayer();
    downloadText(filename, content, mime, this.layer ?? document.body);
  }

  copy(text: string): Promise<boolean> {
    this.ensureLayer();
    return copyText(text, this.layer ?? document.body);
  }

  // --- Plumbing -----------------------------------------------------------------------------

  private ensureLayer(): HTMLElement {
    if (this.layer && this.layerHost?.isConnected) return this.layer;
    const host = document.createElement('chat-exporter-ui');
    host.style.cssText = HOST_STYLE.layer;
    const root = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
    this.adoptStyles(root);
    const toasts = h('div', { class: 'cx-toasts' });
    const layer = h('div', { class: 'cx-theme', attrs: { 'data-bs-theme': this.dark ? 'dark' : 'light' } }, toasts);
    isolateEvents(layer);
    root.append(layer);
    document.documentElement.append(host);
    this.layerHost = host;
    this.layerRoot = root;
    this.layer = layer;
    this.toasts = toasts;
    return layer;
  }

  private adoptStyles(root: ShadowRoot): void {
    try {
      this.sheet ??= new CSSStyleSheet();
      if (this.sheet.cssRules.length === 0) this.sheet.replaceSync(css);
      root.adoptedStyleSheets = [this.sheet];
    } catch {
      root.append(h('style', { text: css }));
    }
  }
}

function proBadge(locked: boolean): HTMLElement {
  return h(
    'span',
    { class: 'cx-pro', attrs: { title: locked ? 'Pro feature: see About Pro' : 'Pro feature (free during early access)' } },
    locked ? icon(ICONS.lockFill, { size: 9 }) : null,
    'PRO',
  );
}

/** The nearest ancestor that scrolls vertically (the chat's thread), or null for the page itself. */
function scrollParent(element: Element): Element | null {
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** The box around all of a message's elements (null when none is laid out). */
function unionRect(elements: readonly Element[]): { left: number; top: number; right: number; bottom: number; width: number; height: number } | null {
  let box: { left: number; top: number; right: number; bottom: number } | null = null;
  for (const element of elements) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    box = box
      ? { left: Math.min(box.left, rect.left), top: Math.min(box.top, rect.top), right: Math.max(box.right, rect.right), bottom: Math.max(box.bottom, rect.bottom) }
      : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  return box ? { ...box, width: box.right - box.left, height: box.bottom - box.top } : null;
}

function isPlaced(host: HTMLElement, target: ButtonTarget): boolean {
  switch (target.position) {
    case 'before':
      return host.nextElementSibling === target.element;
    case 'prepend':
      return host.parentElement === target.element && target.element.firstElementChild === host;
    case 'append':
      return host.parentElement === target.element && target.element.lastElementChild === host;
  }
}

/** Keeps our clicks and keystrokes away from the page's handlers (shortcuts, routers, menus). */
function isolateEvents(element: HTMLElement): void {
  for (const type of ['click', 'mousedown', 'pointerdown', 'keydown', 'keyup', 'keypress'] as const) {
    element.addEventListener(type, (event) => event.stopPropagation());
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}
