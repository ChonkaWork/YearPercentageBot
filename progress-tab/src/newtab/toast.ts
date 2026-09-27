import { byId, setHidden } from '../ui/dom';

export interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
  error?: boolean;
  /** Move keyboard focus to the action (e.g. Undo right after a delete). */
  focusAction?: boolean;
  durationMs?: number;
}

/**
 * One toast at a time, in a polite live region. It stays while hovered or focused, so there is
 * always time to reach the action.
 */
export class Toast {
  private readonly toast = byId<HTMLDivElement>('toast');
  private readonly text = byId<HTMLSpanElement>('toast-text');
  private readonly action = byId<HTMLButtonElement>('toast-action');
  private readonly close = byId<HTMLButtonElement>('toast-close');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private onAction: (() => void) | undefined;
  private durationMs = 0;

  constructor(private readonly returnFocus: () => void) {
    this.action.addEventListener('click', () => {
      const handler = this.onAction;
      this.hide();
      handler?.();
    });
    this.close.addEventListener('click', () => this.hide());
    for (const type of ['mouseenter', 'focusin'] as const) this.toast.addEventListener(type, () => this.pause());
    this.toast.addEventListener('mouseleave', () => this.resume());
    this.toast.addEventListener('focusout', (event) => {
      if (!this.toast.contains(event.relatedTarget as Node | null)) this.resume();
    });
    this.toast.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.hide();
      }
    });
  }

  show(message: string, options: ToastOptions = {}): void {
    this.text.textContent = message;
    this.onAction = options.onAction;
    this.action.textContent = options.actionLabel ?? '';
    setHidden(this.action, !options.actionLabel);
    this.toast.classList.toggle('is-error', Boolean(options.error));
    this.toast.classList.add('show');
    this.durationMs = options.durationMs ?? (options.error ? 10_000 : 8_000);
    if (options.focusAction && options.actionLabel) this.action.focus();
    this.resume();
  }

  hide(): void {
    this.pause();
    const hadFocus = this.toast.contains(document.activeElement);
    this.toast.classList.remove('show');
    this.onAction = undefined;
    if (hadFocus) this.returnFocus();
  }

  private pause(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private resume(): void {
    this.pause();
    if (!this.toast.classList.contains('show')) return;
    if (this.toast.contains(document.activeElement) || this.toast.matches(':hover')) return;
    this.timer = setTimeout(() => this.hide(), this.durationMs);
  }
}
