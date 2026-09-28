import { MAX_CUSTOM_INSTRUCTION_CHARS, MAX_INPUT_CHARS, truncateToLimit } from '../core/limits';
import type { DirectAction, PageContext, PromptAction } from '../core/types';
import type {
  AnchorRect,
  MakePromptRequest,
  MakePromptResponse,
  OverlayMessage,
  PanelMessage,
  TemplateRef,
} from '../platform/messages';
import { isOverlayMessage } from '../platform/messages';
import { saveSettings } from '../storage/store';
import { ACTIONS } from '../templates';
import { copyFromDocument } from '../ui/clipboard';
import { h, logo } from '../ui/dom';
import { icon } from '../ui/icons';
import { copyShortcutLabel, formatChars, formatCount } from '../ui/format';
import css from './overlay.shadow.scss';

/**
 * In-page UI, injected on demand (context menu / shortcut) into the top frame. Lives in a
 * shadow root so the page's CSS can't touch it and it can't touch the page.
 */

const DIRECT_ACTIONS = ACTIONS.filter((action) => action.id !== 'custom');
/** Digits after the built-in actions and Custom (8, 9) pick the first templates. */
const TEMPLATE_KEYS = 2;
const DONE_AUTO_CLOSE_MS = 2800;
const TOAST_MS = { success: 2600, error: 4500 } as const;

interface Session {
  text: string;
  totalLength: number;
  page: PageContext | null;
  includePageContext: boolean;
  defaultAction: DirectAction;
  instruction: string;
  templates: TemplateRef[];
}

/** What to run: a built-in action (with the Custom instruction) or a custom template. */
type Next = { action: PromptAction; instruction?: string } | { template: TemplateRef };

type View =
  | { name: 'actions' }
  | { name: 'custom'; error?: string }
  | { name: 'too-large'; next: Next | null }
  | { name: 'done'; prompt: string; historySaved: boolean }
  | { name: 'manual-copy'; prompt: string }
  | { name: 'error'; message: string; title?: string };

class Overlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private layer: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private meta: HTMLElement | null = null;
  private toast: HTMLElement | null = null;
  private session: Session | null = null;
  private view: View = { name: 'actions' };
  private anchor: AnchorRect | null = null;
  private busy = false;
  private hovered = false;
  private closeTimer: number | undefined;
  private toastTimer: number | undefined;
  private returnFocus: Element | null = null;

  handle(message: OverlayMessage): void {
    switch (message.view) {
      case 'panel':
        this.openPanel(message);
        break;
      case 'toast':
        this.showToast(message.tone, message.message);
        break;
      case 'manual-copy':
        this.openWith(null, { name: 'manual-copy', prompt: message.prompt });
        break;
    }
  }

  // --- Lifecycle ------------------------------------------------------------------------

  private openPanel(message: PanelMessage): void {
    const session: Session = {
      text: message.text,
      totalLength: message.totalLength,
      page: message.page,
      includePageContext: message.includePageContext,
      defaultAction: message.defaultAction,
      instruction: message.lastInstruction,
      templates: message.templates,
    };
    this.anchor = message.anchor;
    const tooLarge = session.totalLength > MAX_INPUT_CHARS;
    const next = message.preset ?? null;
    this.openWith(session, tooLarge ? { name: 'too-large', next } : { name: 'actions' });
  }

  private openWith(session: Session | null, view: View): void {
    const layer = this.ensureLayer();
    this.close();
    this.session = session;
    this.returnFocus = document.activeElement;

    this.meta = h('span', { class: 'meta' });
    this.body = h('div', { class: 'body' });
    const closeButton = h(
      'button',
      { class: 'icon-button', attrs: { type: 'button', 'aria-label': 'Close Pastebot' }, on: { click: () => this.close(true) } },
      icon('xLg'),
    );
    const card = h(
      'div',
      { class: 'card', attrs: { role: 'dialog', 'aria-label': 'Pastebot' } },
      h('div', { class: 'head' }, h('span', { class: 'brand' }, logo(18), 'Pastebot'), this.meta, closeButton),
      this.body,
    );
    card.addEventListener('keydown', (event) => this.onKeyDown(event));
    // Keep keystrokes typed in the panel away from page shortcuts (YouTube, GitHub, ...).
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      card.addEventListener(type, (event) => event.stopPropagation());
    }
    card.addEventListener('mouseenter', () => {
      this.hovered = true;
    });
    card.addEventListener('mouseleave', () => {
      this.hovered = false;
    });
    this.card = card;
    layer.append(card);

    document.addEventListener('mousedown', this.onOutsidePointer, true);
    window.addEventListener('keydown', this.onWindowKeyDown, true);
    window.addEventListener('resize', this.onResize);
    this.render(view);
  }

  /** Removes everything from the page (used when a newer copy of the script takes over). */
  destroy(): void {
    this.close();
    window.clearTimeout(this.toastTimer);
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.layer = null;
    this.toast = null;
  }

  private close(restoreFocus = false): void {
    window.clearTimeout(this.closeTimer);
    document.removeEventListener('mousedown', this.onOutsidePointer, true);
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    if (!this.card) return;
    this.card.remove();
    this.card = null;
    this.body = null;
    this.session = null;
    this.busy = false;
    this.hovered = false;
    if (restoreFocus && this.returnFocus instanceof HTMLElement && this.returnFocus.isConnected) {
      this.returnFocus.focus({ preventScroll: true });
    }
    this.returnFocus = null;
  }

  private ensureLayer(): HTMLElement {
    if (this.layer && this.host?.isConnected) return this.layer;
    const host = document.createElement('pastebot-overlay');
    host.style.cssText =
      'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;';
    const root = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', { text: css }));
    }
    const layer = h('div', { class: 'layer' });
    root.append(layer);
    document.documentElement.append(host);
    this.host = host;
    this.root = root;
    this.layer = layer;
    return layer;
  }

  private readonly onOutsidePointer = (event: MouseEvent): void => {
    if (this.host && !event.composedPath().includes(this.host)) this.close();
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.card) return;
    if (this.host && event.composedPath().includes(this.host)) return; // handled inside the card
    this.close(true);
  };

  private readonly onResize = (): void => this.position();

  // --- Rendering --------------------------------------------------------------------------

  private render(view: View): void {
    const body = this.body;
    if (!body || !this.card) return;
    this.view = view;
    window.clearTimeout(this.closeTimer);
    if (this.meta) this.meta.textContent = this.session ? formatChars(this.session.totalLength) : '';

    let focusTarget: HTMLElement | null = null;
    switch (view.name) {
      case 'actions':
        focusTarget = this.renderActions(body);
        break;
      case 'custom':
        focusTarget = this.renderCustom(body, view.error);
        break;
      case 'too-large':
        focusTarget = this.renderTooLarge(body, view.next);
        break;
      case 'done':
        focusTarget = this.renderDone(body, view.prompt, view.historySaved);
        break;
      case 'manual-copy':
        focusTarget = this.renderManualCopy(body, view.prompt);
        break;
      case 'error':
        focusTarget = this.renderError(body, view.message, view.title);
        break;
    }
    this.position();
    focusTarget?.focus({ preventScroll: true });
  }

  private renderActions(body: HTMLElement): HTMLElement | null {
    const session = this.session;
    if (!session) return null;
    let defaultButton: HTMLButtonElement | undefined;
    const grid = h('div', { class: 'grid' });
    for (const [index, action] of DIRECT_ACTIONS.entries()) {
      const button = h(
        'button',
        {
          class: action.id === session.defaultAction ? 'btn action default' : 'btn action',
          attrs: { type: 'button', title: action.description, 'data-action': action.id },
          on: { click: () => void this.run({ action: action.id }) },
        },
        h('kbd', { text: String(index + 1) }),
        h('span', { text: action.label }),
      );
      if (action.id === session.defaultAction) defaultButton = button;
      grid.append(button);
    }
    const customButton = h(
      'button',
      {
        class: 'btn action custom',
        attrs: { type: 'button', title: 'Write your own instruction', 'data-action': 'custom' },
        on: { click: () => this.render({ name: 'custom' }) },
      },
      h('kbd', { text: String(DIRECT_ACTIONS.length + 1) }),
      h('span', { text: 'Custom…' }),
    );

    body.replaceChildren(
      h('p', { class: 'preview' }, h('span', { class: 'preview-text', text: previewOf(session.text) })),
      grid,
      customButton,
      ...[this.templatesSection(session.templates)].filter((node) => node !== null),
      this.pageContextToggle(session),
      h('p', { class: 'status', attrs: { role: 'status' } }),
    );
    return defaultButton ?? grid.querySelector('button');
  }

  private templatesSection(templates: TemplateRef[]): HTMLElement | null {
    if (templates.length === 0) return null;
    const firstKey = DIRECT_ACTIONS.length + 2;
    const list = h('div', { class: 'templates', attrs: { role: 'group', 'aria-label': 'Your templates' } });
    for (const [index, template] of templates.entries()) {
      list.append(
        h(
          'button',
          {
            class: 'btn action template',
            attrs: { type: 'button', title: template.name, 'data-template-id': template.id },
            on: { click: () => void this.run({ template }) },
          },
          index < TEMPLATE_KEYS ? h('kbd', { text: String(firstKey + index) }) : icon('bookmark'),
          h('span', { class: 'label', text: template.name }),
        ),
      );
    }
    return h(
      'div',
      { class: 'templates-block' },
      h('p', { class: 'section-label' }, h('span', { text: 'Your templates' }), h('span', { class: 'pro-badge', text: 'PRO', attrs: { title: 'A Pastebot Pro feature' } })),
      list,
    );
  }

  private pageContextToggle(session: Session): HTMLElement {
    const available = session.page !== null;
    const input = h('input', {
      class: 'form-check-input',
      attrs: { type: 'checkbox', role: 'switch', id: 'pb-page-context' },
    });
    input.checked = available && session.includePageContext;
    input.disabled = !available;
    input.addEventListener('change', () => {
      session.includePageContext = input.checked;
      saveSettings({ includePageContext: input.checked }).catch(() => {
        this.setStatus("Couldn't save this preference.", true);
      });
    });
    return h(
      'div',
      {
        class: 'form-check form-switch',
        attrs: { title: available ? 'Adds the page title and URL to the prompt' : 'No page information available' },
      },
      input,
      h('label', { class: 'form-check-label', text: 'Include page title & URL', attrs: { for: 'pb-page-context' } }),
    );
  }

  private renderCustom(body: HTMLElement, error?: string): HTMLElement {
    const session = this.session;
    const textarea = h('textarea', {
      class: 'form-control',
      attrs: {
        id: 'pb-instruction',
        rows: '3',
        maxlength: String(MAX_CUSTOM_INSTRUCTION_CHARS),
        placeholder: 'e.g. Turn this into a professional email',
      },
    });
    textarea.value = session?.instruction ?? '';
    const submit = () => {
      if (session) session.instruction = textarea.value;
      void this.run({ action: 'custom', instruction: textarea.value });
    };
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    body.replaceChildren(
      h('label', { class: 'field-label', text: 'What should the AI do with this text?', attrs: { for: 'pb-instruction' } }),
      textarea,
      h('p', { class: error ? 'status error' : 'status', text: error ?? '', attrs: { role: 'alert' } }),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'btn btn-sm btn-outline-secondary ghost', text: 'Back', attrs: { type: 'button' }, on: { click: () => this.render({ name: 'actions' }) } }),
        h('button', { class: 'btn btn-sm btn-primary primary', text: 'Make Prompt', attrs: { type: 'button' }, on: { click: submit } }),
      ),
      h('p', { class: 'hint', text: 'Enter to make the prompt · Shift+Enter for a new line' }),
    );
    textarea.select();
    return textarea;
  }

  private renderTooLarge(body: HTMLElement, next: Next | null): HTMLElement {
    const session = this.session;
    const length = session?.totalLength ?? 0;
    const keep = h('button', {
      class: 'btn btn-sm btn-primary primary',
      text: `Use first ${formatCount(MAX_INPUT_CHARS)}`,
      attrs: { type: 'button' },
      on: {
        click: () => {
          if (!session) return;
          session.text = truncateToLimit(session.text, MAX_INPUT_CHARS);
          session.totalLength = session.text.length;
          if (next) void this.run(next);
          else this.render({ name: 'actions' });
        },
      },
    });
    body.replaceChildren(
      h('p', { class: 'headline warn' }, icon('exclamationTriangleFill'), 'This selection is too long'),
      h('p', {
        class: 'muted',
        text: `It has ${formatCount(length)} characters. Pastebot handles up to ${formatCount(MAX_INPUT_CHARS)}. Select less text, or keep only the beginning.`,
      }),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'btn btn-sm btn-outline-secondary ghost', text: 'Cancel', attrs: { type: 'button' }, on: { click: () => this.close(true) } }),
        keep,
      ),
    );
    return keep;
  }

  private renderDone(body: HTMLElement, prompt: string, historySaved: boolean): HTMLElement | null {
    body.replaceChildren(
      h('p', { class: 'headline success' }, icon('checkCircleFill'), 'Prompt copied'),
      h('p', { class: 'muted', text: 'Paste it into ChatGPT, Claude, Gemini or any AI tool.' }),
      h('pre', { class: 'prompt-preview', text: firstLines(prompt, 7) }),
    );
    if (!historySaved) body.append(h('p', { class: 'muted small', text: "Couldn't save it to history." }));
    this.scheduleAutoClose();
    return null;
  }

  private renderManualCopy(body: HTMLElement, prompt: string): HTMLElement {
    const textarea = h('textarea', { class: 'form-control manual', attrs: { rows: '7', readonly: '', 'aria-label': 'Generated prompt' } });
    textarea.value = prompt;
    textarea.addEventListener('copy', () => {
      window.setTimeout(() => this.render({ name: 'done', prompt, historySaved: true }), 0);
    });
    body.replaceChildren(
      h('p', { class: 'headline warn' }, icon('exclamationTriangleFill'), "Couldn't copy automatically"),
      h('p', { class: 'muted', text: `Press ${copyShortcutLabel()} to copy the prompt below.` }),
      textarea,
      h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-sm btn-outline-secondary ghost', text: 'Close', attrs: { type: 'button' }, on: { click: () => this.close(true) } })),
    );
    window.setTimeout(() => textarea.select(), 0);
    return textarea;
  }

  private renderError(body: HTMLElement, message: string, title = 'Something went wrong'): HTMLElement {
    const close = h('button', { class: 'btn btn-sm btn-outline-secondary ghost', text: 'Close', attrs: { type: 'button' }, on: { click: () => this.close(true) } });
    body.replaceChildren(
      h('p', { class: 'headline warn' }, icon('exclamationTriangleFill'), title),
      h('p', { class: 'muted', text: message }),
      h('div', { class: 'row-actions' }, close),
    );
    return close;
  }

  private setStatus(text: string, isError = false): void {
    const status = this.body?.querySelector('.status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.card?.setAttribute('aria-busy', String(busy));
    for (const button of this.body?.querySelectorAll('button') ?? []) button.disabled = busy;
  }

  private scheduleAutoClose(): void {
    window.clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => {
      if (this.hovered) this.scheduleAutoClose();
      else this.close(true);
    }, DONE_AUTO_CLOSE_MS);
  }

  private position(): void {
    const card = this.card;
    if (!card) return;
    const margin = 12;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const { width, height } = card.getBoundingClientRect();
    const anchor = this.anchor;
    let top: number;
    let left: number;
    if (anchor && anchor.bottom >= 0 && anchor.top <= viewportHeight) {
      top = anchor.bottom + 8;
      if (top + height > viewportHeight - margin) top = anchor.top - height - 8;
      left = anchor.left;
    } else {
      top = margin + 4;
      left = viewportWidth - width - margin - 4;
    }
    card.style.left = `${clamp(left, margin, viewportWidth - width - margin)}px`;
    card.style.top = `${clamp(top, margin, viewportHeight - height - margin)}px`;
  }

  // --- Actions ----------------------------------------------------------------------------

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.view.name === 'custom') this.render({ name: 'actions' });
      else this.close(true);
      return;
    }
    if (this.view.name !== 'actions' || this.busy || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const index = Number(event.key) - 1;
    if (index === DIRECT_ACTIONS.length) {
      event.preventDefault();
      this.render({ name: 'custom' });
      return;
    }
    const action = DIRECT_ACTIONS[index];
    const templateIndex = index - DIRECT_ACTIONS.length - 1;
    const template = templateIndex >= 0 && templateIndex < TEMPLATE_KEYS ? this.session?.templates[templateIndex] : undefined;
    if (action) {
      event.preventDefault();
      void this.run({ action: action.id });
    } else if (template) {
      event.preventDefault();
      void this.run({ template });
    }
  }

  private async run(next: Next): Promise<void> {
    const session = this.session;
    if (!session || this.busy) return;
    this.setBusy(true);
    this.setStatus('Making prompt…');

    const request: MakePromptRequest = {
      type: 'pastebot/make',
      action: 'action' in next ? next.action : 'custom',
      text: session.text,
      includePageContext: session.includePageContext && session.page !== null,
      page: session.page,
      copy: true,
    };
    if ('template' in next) request.templateId = next.template.id;
    else if (next.instruction !== undefined) request.customInstruction = next.instruction;

    let response: MakePromptResponse | undefined;
    try {
      response = (await chrome.runtime.sendMessage(request)) as MakePromptResponse | undefined;
    } catch {
      this.render({ name: 'error', message: 'Pastebot was updated or restarted. Reload this page and try again.' });
      return;
    } finally {
      if (this.card) this.setBusy(false);
    }
    if (!this.card) return; // Closed while waiting.

    if (!response) {
      this.render({ name: 'error', message: 'Pastebot did not respond. Please try again.' });
      return;
    }
    if (!response.ok) {
      if (response.code === 'TEXT_TOO_LARGE') {
        session.totalLength = response.length ?? session.totalLength;
        this.render({ name: 'too-large', next });
      } else if ('action' in next && next.action === 'custom' && (response.code === 'EMPTY_INSTRUCTION' || response.code === 'INSTRUCTION_TOO_LONG')) {
        this.render({ name: 'custom', error: response.message });
      } else if (response.code === 'PRO_REQUIRED') {
        this.render({ name: 'error', title: 'Part of Pastebot Pro', message: response.message });
      } else {
        this.render({ name: 'error', message: response.message });
      }
      return;
    }

    // The background copy failed (rare): try from the page while the click still counts as a user gesture.
    const copied = response.copied || (this.root ? await copyFromDocument(response.prompt, this.root) : false);
    if (!this.card) return;
    this.render(
      copied
        ? { name: 'done', prompt: response.prompt, historySaved: response.historySaved }
        : { name: 'manual-copy', prompt: response.prompt },
    );
  }

  // --- Toast ------------------------------------------------------------------------------

  private showToast(tone: 'success' | 'error', message: string): void {
    const layer = this.ensureLayer();
    window.clearTimeout(this.toastTimer);
    this.toast?.remove();
    const toast = h(
      'div',
      { class: `toast ${tone}`, attrs: { role: tone === 'error' ? 'alert' : 'status' } },
      icon(tone === 'success' ? 'checkCircleFill' : 'exclamationTriangleFill'),
      h('span', { text: message }),
    );
    layer.append(toast);
    this.toast = toast;
    this.toastTimer = window.setTimeout(() => {
      toast.remove();
      if (this.toast === toast) this.toast = null;
    }, TOAST_MS[tone]);
  }
}

function previewOf(text: string): string {
  const flat = text.slice(0, 400).replace(/\s+/g, ' ').trim();
  return `“${flat.length > 160 ? `${flat.slice(0, 159).trimEnd()}…` : flat}”`;
}

function firstLines(text: string, count: number): string {
  const lines = text.split('\n');
  return lines.length > count ? `${lines.slice(0, count).join('\n')}\n…` : text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

// The script is injected on every invocation; only the first run sets things up. After the
// extension is updated or reloaded, a copy injected earlier is orphaned (its runtime is
// gone) but its globals may survive in the page, so a dead instance is replaced.
interface Installed {
  overlay: Overlay;
  runtime: typeof chrome.runtime;
}

const GLOBAL_KEY = '__pastebotOverlay';
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
  installed?.overlay.destroy();
  const overlay = new Overlay();
  scope[GLOBAL_KEY] = { overlay, runtime: chrome.runtime };
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isOverlayMessage(message)) return false;
    overlay.handle(message);
    sendResponse({ ok: true });
    return false;
  });
}
