import { featureFor, type ExportAction } from '../export/actions';
import type { ButtonTarget } from '../sites/types';
import { copyText } from '../ui/clipboard';
import { h } from '../ui/dom';
import { downloadText } from '../ui/download';
import { icon, ICONS, type IconData } from '../ui/icons';
import css from '../styles/inpage.scss';

/**
 * The in-page UI: an "Export" button (in the site's header when the adapter finds a spot, a
 * small floating button otherwise), its menu, and toasts. Everything lives in shadow roots, so
 * the page's CSS can't touch it and it can't touch the page.
 */

export type UiAction = ExportAction | 'options';

export interface MenuInfo {
  title: string;
  meta: string;
  /** Active export options, e.g. "Last 10 messages · No code blocks". */
  options?: string;
  /** Pro actions the current plan doesn't include: shown with a lock, they explain Pro instead. */
  locked: readonly UiAction[];
  /** Shown instead of the actions when the conversation can't be read. */
  error?: string;
  /** Shown above the actions (e.g. a reply is still being written). */
  warning?: string;
}

export interface UiCallbacks {
  describe(): MenuInfo;
  run(action: UiAction): Promise<void>;
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
  pro: action === 'options' || featureFor(action) !== null,
});

const COPY_ITEM = item('copy', 'Copy as Markdown', ICONS.clipboard);
const DOWNLOAD_ITEMS: MenuItem[] = [
  item('markdown', 'Markdown', ICONS.markdown, '.md'),
  item('text', 'Plain text', ICONS.fileEarmarkText, '.txt'),
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
  private dark = false;
  private busy = false;

  constructor(private readonly callbacks: UiCallbacks) {}

  // --- Button -------------------------------------------------------------------------------

  /** Places the button at `target`, or floating when there is none. Cheap when nothing changed. */
  mount(target: ButtonTarget | null): void {
    const mode = target ? 'inline' : 'floating';
    const host = this.buttonHost ?? this.createButton();
    if (host.isConnected && host.dataset.mode === mode && (!target || isPlaced(host, target))) return;
    this.closeMenu();
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
        on: { click: () => (this.menu ? this.closeMenu(true) : this.openMenu()) },
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

  private openMenu(): void {
    const trigger = this.trigger;
    if (!trigger) return;
    const layer = this.ensureLayer();
    const info = this.callbacks.describe();
    const button = (entry: MenuItem): HTMLButtonElement => {
      const locked = info.locked.includes(entry.action);
      const element = h(
        'button',
        {
          class: `dropdown-item${locked ? ' cx-locked' : ''}`,
          attrs: { type: 'button', role: 'menuitem', 'data-action': entry.action },
          on: { click: () => void this.select(entry.action) },
        },
        icon(entry.icon),
        h('span', { text: entry.label }),
        entry.pro ? proBadge(locked) : null,
        entry.extension ? h('span', { class: 'cx-ext', text: entry.extension }) : null,
      );
      // Exports need a readable conversation; the options page doesn't.
      element.disabled = Boolean(info.error) && entry.action !== 'options';
      return element;
    };
    const copyItem = button(COPY_ITEM);
    const fileItems = DOWNLOAD_ITEMS.map(button);
    const optionsItem = button(OPTIONS_ITEM);
    const items = [copyItem, ...fileItems, optionsItem];

    const menu = h(
      'div',
      { class: 'dropdown-menu show cx-menu', attrs: { role: 'menu', 'aria-label': 'Export conversation' } },
      h('h6', { class: 'dropdown-header', text: info.title, attrs: { title: info.title } }),
      h('div', { class: 'cx-menu-meta', text: info.meta }),
      info.options ? h('div', { class: 'cx-menu-options' }, icon(ICONS.sliders), h('span', { text: info.options })) : null,
      info.error
        ? h('div', { class: 'cx-menu-warning', attrs: { role: 'alert' } }, icon(ICONS.exclamationTriangleFill), h('span', { text: info.error }))
        : null,
      info.warning ? h('div', { class: 'cx-menu-warning' }, icon(ICONS.infoCircleFill), h('span', { text: info.warning })) : null,
      h('div', { class: 'dropdown-divider' }),
      copyItem,
      h('h6', { class: 'dropdown-header cx-section', text: 'Download' }),
      ...fileItems,
      h('div', { class: 'dropdown-divider' }),
      optionsItem,
    );
    menu.addEventListener('keydown', (event) => this.onMenuKey(event, items));
    layer.append(menu);
    this.menu = menu;
    trigger.setAttribute('aria-expanded', 'true');
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
    this.trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.trigger?.focus({ preventScroll: true });
  }

  private positionMenu(): void {
    const menu = this.menu;
    const trigger = this.trigger;
    if (!menu || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
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
    if ((this.layerHost && path.includes(this.layerHost)) || (this.buttonHost && path.includes(this.buttonHost))) return;
    this.closeMenu();
  };

  private readonly onViewportChange = (): void => this.closeMenu();

  private async select(action: UiAction): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.closeMenu(true);
    try {
      await this.callbacks.run(action);
    } finally {
      this.busy = false;
    }
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
