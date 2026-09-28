import {
  MAX_NAME_LENGTH,
  describeCountdown,
  sortCountdowns,
  validateDraft,
  type Countdown,
  type CountdownFields,
  type DraftErrors,
  type DraftField,
} from '../core/countdown';
import { errorMessage, h, placeChildren, setAttr, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { createBar, updateBar, type Bar } from './progress';
import type { Toast } from './toast';

/** Storage operations; each resolves once the change is saved and throws when it isn't. */
export interface CountdownActions {
  add(fields: CountdownFields): Promise<Countdown>;
  update(id: string, fields: CountdownFields): Promise<void>;
  remove(id: string): Promise<Countdown>;
  restore(countdown: Countdown): Promise<void>;
  reload(): void;
  /** Opens the About Pro card (from the limit message). */
  aboutPro(): void;
}

export interface CountdownLimit {
  /** The plan's limit; only adding is blocked, longer lists are kept. */
  max: number;
  /** Calm text shown when Add is pressed at the limit. */
  message: string;
  /** Whether Pro would lift it (shows the About Pro link). */
  upgradable: boolean;
}

export interface CountdownDisplay {
  hour12: boolean;
  decimals: number;
}

type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

// --- One countdown -----------------------------------------------------------------------------

class CountdownItem {
  readonly root: HTMLLIElement;
  readonly editButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly name = h('h3', { class: 'countdown-name' });
  private readonly status = h('span', { class: 'countdown-status' });
  private readonly statusValue = h('span');
  private readonly statusSuffix = h('span', { class: 'visually-hidden' });
  private readonly target = h('span', { class: 'countdown-target' });
  private readonly progress: HTMLDivElement;
  private readonly progressText = h('span', { class: 'countdown-progress-text' });
  private readonly bar: Bar = createBar('Progress since it was added');

  constructor(
    readonly id: string,
    handlers: { edit(id: string): void; remove(id: string): void },
  ) {
    this.status.append(this.statusValue, this.statusSuffix);
    this.editButton = h('button', { class: 'btn-icon btn-sm', attrs: { type: 'button', title: 'Edit' }, on: { click: () => handlers.edit(id) } }, icon('pencil'));
    this.deleteButton = h(
      'button',
      { class: 'btn-icon btn-sm', attrs: { type: 'button', title: 'Delete' }, on: { click: () => handlers.remove(id) } },
      icon('trash3'),
    );
    this.progress = h('div', { class: 'countdown-progress' }, this.bar.track, this.progressText);
    this.root = h(
      'li',
      { class: 'list-group-item countdown', attrs: { 'data-id': id } },
      this.name,
      this.status,
      this.target,
      h('div', { class: 'countdown-actions' }, this.editButton, this.deleteButton),
      this.progress,
    );
  }

  update(countdown: Countdown, now: Date, display: CountdownDisplay): void {
    const view = describeCountdown(countdown, now, display);
    setText(this.name, countdown.name);
    setAttr(this.editButton, 'aria-label', `Edit “${countdown.name}”`);
    setAttr(this.deleteButton, 'aria-label', `Delete “${countdown.name}”`);
    if (!view) {
      // Storage is sanitized, so this is only a safety net.
      setText(this.statusValue, 'Invalid date');
      setHidden(this.progress, true);
      return;
    }
    setText(this.statusValue, view.statusText);
    setText(this.statusSuffix, view.state === 'upcoming' ? ' left' : '');
    this.status.classList.toggle('is-today', view.state === 'today');
    this.status.classList.toggle('is-passed', view.state === 'passed');
    setAttr(this.root, 'data-state', view.state);
    setText(this.target, view.targetText);
    setHidden(this.progress, view.progress === null);
    if (view.progress && view.fraction !== null) {
      setText(this.progressText, view.progress.text);
      updateBar(this.bar, view.fraction, view.progress.value, view.progress.text);
    }
  }

  highlight(): void {
    this.root.classList.add('is-new');
    // Two frames so the highlight paints before it fades out.
    requestAnimationFrame(() => requestAnimationFrame(() => this.root.classList.remove('is-new')));
  }
}

// --- Add / edit form ---------------------------------------------------------------------------

let formCount = 0;

interface FormHandlers {
  submit(fields: CountdownFields): Promise<void>;
  cancel(): void;
}

class CountdownForm {
  readonly root: HTMLLIElement;
  private readonly form: HTMLFormElement;
  private readonly inputs: Record<DraftField, HTMLInputElement>;
  private readonly feedback: Record<DraftField, HTMLDivElement>;
  private readonly showProgress: HTMLInputElement;
  private readonly saveError = h('div', { class: 'alert alert-danger alert-with-icon', attrs: { role: 'alert' } });
  private readonly saveButton: HTMLButtonElement;
  private busy = false;

  constructor(
    /** null for a new countdown. */
    readonly countdownId: string | null,
    initial: Countdown | null,
    private readonly handlers: FormHandlers,
  ) {
    const prefix = `countdown-form-${++formCount}`;
    const field = (name: DraftField, input: HTMLInputElement, label: Node | string, feedback: HTMLDivElement) => {
      input.id = `${prefix}-${name}`;
      feedback.id = `${prefix}-${name}-error`;
      input.className = 'form-control';
      input.setAttribute('aria-describedby', feedback.id);
      return h('div', {}, h('label', { class: 'form-label', attrs: { for: input.id } }, label), input, feedback);
    };

    this.inputs = {
      name: h('input', { attrs: { type: 'text', maxlength: String(MAX_NAME_LENGTH), autocomplete: 'off', placeholder: 'e.g. Summer vacation', required: '' } }),
      date: h('input', { attrs: { type: 'date', min: '1000-01-01', max: '9999-12-31', required: '' } }),
      time: h('input', { attrs: { type: 'time' } }),
    };
    this.feedback = {
      name: h('div', { class: 'invalid-feedback' }),
      date: h('div', { class: 'invalid-feedback' }),
      time: h('div', { class: 'invalid-feedback' }),
    };
    this.showProgress = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', role: 'switch', id: `${prefix}-progress` } });

    this.inputs.name.value = initial?.name ?? '';
    this.inputs.date.value = initial?.date ?? '';
    this.inputs.time.value = initial?.time ?? '';
    this.showProgress.checked = initial?.showProgress ?? true;
    setHidden(this.saveError, true);

    this.saveButton = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'submit' }, text: initial ? 'Save' : 'Add countdown' });
    const cancel = h('button', { class: 'btn btn-quiet btn-sm', attrs: { type: 'button' }, text: 'Cancel', on: { click: () => this.handlers.cancel() } });

    this.form = h(
      'form',
      {
        attrs: { novalidate: '', 'aria-label': initial ? `Edit “${initial.name}”` : 'New countdown' },
        on: {
          submit: (event) => {
            event.preventDefault();
            void this.submit();
          },
          keydown: (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this.handlers.cancel();
          },
        },
      },
      field('name', this.inputs.name, 'Name', this.feedback.name),
      h(
        'div',
        { class: 'form-fields' },
        field('date', this.inputs.date, 'Date', this.feedback.date),
        field('time', this.inputs.time, h('span', {}, 'Time ', h('span', { class: 'text-body-secondary fw-normal', text: '(optional)' })), this.feedback.time),
      ),
      h(
        'div',
        { class: 'form-check form-switch' },
        this.showProgress,
        h('label', { class: 'form-check-label', attrs: { for: this.showProgress.id }, text: 'Show progress since it was added' }),
      ),
      this.saveError,
      h('div', { class: 'form-actions' }, this.saveButton, cancel, h('span', { class: 'form-hint', text: 'Enter saves · Esc cancels' })),
    );
    this.root = h('li', { class: 'list-group-item countdown-form', attrs: { 'data-id': countdownId ?? 'new' } }, this.form);
  }

  /** Focuses the name and brings the whole form (with its buttons) into view. */
  focus(): void {
    this.inputs.name.focus({ preventScroll: true });
    this.root.scrollIntoView({ block: 'nearest' });
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const result = validateDraft({
      name: this.inputs.name.value,
      date: this.inputs.date.value,
      time: this.inputs.time.value,
      showProgress: this.showProgress.checked,
      dateIncomplete: this.inputs.date.validity.badInput,
      timeIncomplete: this.inputs.time.validity.badInput,
    });
    this.showErrors(result.ok ? {} : result.errors);
    this.showSaveError(null);
    if (!result.ok) return;

    this.setBusy(true);
    try {
      await this.handlers.submit(result.value);
    } catch (error) {
      this.showSaveError(`Couldn’t save the countdown: ${errorMessage(error)}`);
      this.setBusy(false);
    }
  }

  private showErrors(errors: DraftErrors): void {
    let first: HTMLInputElement | null = null;
    for (const name of ['name', 'date', 'time'] as const) {
      const message = errors[name];
      const input = this.inputs[name];
      input.classList.toggle('is-invalid', Boolean(message));
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      this.feedback[name].textContent = message ?? '';
      if (message && !first) first = input;
    }
    first?.focus();
  }

  private showSaveError(message: string | null): void {
    this.saveError.replaceChildren(...(message ? [icon('exclamationTriangleFill'), h('span', { text: message })] : []));
    setHidden(this.saveError, !message);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.saveButton.disabled = busy;
    this.form.setAttribute('aria-busy', String(busy));
  }
}

// --- Section -----------------------------------------------------------------------------------

export class CountdownSection {
  private readonly list = h('ul', { class: 'list-group list-group-flush countdown-list' });
  private readonly empty: HTMLDivElement;
  private readonly emptyAdd: HTMLButtonElement;
  private readonly loading: HTMLDivElement;
  private readonly error: HTMLDivElement;
  private readonly errorText = h('span');
  private readonly limitNote: HTMLDivElement;
  private readonly limitText = h('span');
  private readonly limitLink: HTMLButtonElement;
  private limit: CountdownLimit = { max: Number.POSITIVE_INFINITY, message: '', upgradable: false };
  private limitShown = false;
  private readonly items = new Map<string, CountdownItem>();
  private countdowns: Countdown[] = [];
  private state: LoadState = { kind: 'loading' };
  private showSkeleton = false;
  private form: CountdownForm | null = null;
  private now = new Date();
  private display: CountdownDisplay = { hour12: false, decimals: 1 };

  constructor(
    private readonly section: HTMLElement,
    body: HTMLElement,
    private readonly addButton: HTMLButtonElement,
    private readonly actions: CountdownActions,
    private readonly toast: Toast,
  ) {
    this.emptyAdd = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'button' }, on: { click: () => this.openForm(null) } }, icon('plusLg'), ' Add countdown');
    this.empty = h(
      'div',
      { class: 'countdowns-empty' },
      h('span', { class: 'empty-icon' }, icon('hourglassSplit')),
      h('p', { text: 'No countdowns yet. Add a date you’re looking forward to.' }),
      this.emptyAdd,
    );
    this.loading = h(
      'div',
      { class: 'countdowns-loading placeholder-glow', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'placeholder sk-wide' }),
      h('span', { class: 'placeholder sk-narrow' }),
    );
    this.error = h(
      'div',
      { class: 'alert alert-danger countdowns-error', attrs: { role: 'alert' } },
      h('p', { class: 'mb-2' }, h('strong', { text: 'Couldn’t load your countdowns. ' }), this.errorText),
      h('button', { class: 'btn btn-danger btn-sm', attrs: { type: 'button' }, text: 'Try again', on: { click: () => this.actions.reload() } }),
    );
    this.limitLink = h('button', { class: 'btn btn-link btn-sm link-inline', attrs: { type: 'button' }, text: 'About Pro', on: { click: () => this.actions.aboutPro() } });
    this.limitNote = h('div', { class: 'countdown-limit', attrs: { role: 'status' } }, icon('infoCircle'), h('p', {}, this.limitText, ' ', this.limitLink));
    body.replaceChildren(this.loading, this.error, this.empty, this.list, this.limitNote);
    addButton.addEventListener('click', () => this.openForm(null));
    // A skeleton only when storage is slow, so a normal load doesn't flash it.
    setTimeout(() => {
      this.showSkeleton = true;
      this.render();
    }, 150);
    this.render();
  }

  setLimit(limit: CountdownLimit): void {
    this.limit = limit;
    this.render();
  }

  setLoading(): void {
    this.state = { kind: 'loading' };
    this.render();
  }

  setError(message: string): void {
    this.state = { kind: 'error', message };
    this.render();
  }

  setCountdowns(countdowns: Countdown[]): void {
    this.countdowns = countdowns;
    this.state = { kind: 'ready' };
    if (this.form?.countdownId && !countdowns.some((countdown) => countdown.id === this.form?.countdownId)) {
      this.closeForm(false);
      this.toast.show('The countdown you were editing was deleted in another tab.');
    }
    this.render();
  }

  /** Called every second. */
  update(now: Date, display: CountdownDisplay): void {
    this.now = now;
    this.display = display;
    this.render();
  }

  /** Where focus goes when the thing that had it disappears. */
  focusAdd(): void {
    if (this.form) this.form.focus();
    else (this.addButton.hidden ? this.emptyAdd : this.addButton).focus();
  }

  private render(): void {
    const { state } = this;
    setAttr(this.section, 'data-state', state.kind);
    setHidden(this.loading, !(state.kind === 'loading' && this.showSkeleton));
    setHidden(this.error, state.kind !== 'error');
    if (state.kind === 'error') setText(this.errorText, state.message);
    if (state.kind !== 'ready') {
      setHidden(this.limitNote, true);
      setHidden(this.empty, true);
      setHidden(this.list, true);
      setHidden(this.addButton, true);
      return;
    }

    if (this.countdowns.length < this.limit.max) this.limitShown = false;
    setHidden(this.limitNote, !this.limitShown);
    if (this.limitShown) {
      setText(this.limitText, this.limit.message);
      setHidden(this.limitLink, !this.limit.upgradable);
    }

    const sorted = sortCountdowns(this.countdowns, this.now);
    const nothing = sorted.length === 0 && !this.form;
    setHidden(this.empty, !nothing);
    setHidden(this.addButton, nothing || this.form?.countdownId === null);
    setHidden(this.list, nothing);

    const ids = new Set(sorted.map((countdown) => countdown.id));
    for (const [id, item] of this.items) {
      if (ids.has(id)) continue;
      item.root.remove();
      this.items.delete(id);
    }

    const nodes: HTMLElement[] = [];
    if (this.form && this.form.countdownId === null) nodes.push(this.form.root);
    for (const countdown of sorted) {
      let item = this.items.get(countdown.id);
      if (!item) {
        item = new CountdownItem(countdown.id, { edit: (id) => this.openForm(id), remove: (id) => void this.remove(id) });
        this.items.set(countdown.id, item);
      }
      item.update(countdown, this.now, this.display);
      nodes.push(this.form?.countdownId === countdown.id ? this.form.root : item.root);
    }
    placeChildren(this.list, nodes);
  }

  private openForm(countdownId: string | null): void {
    if (countdownId === null && this.countdowns.length >= this.limit.max) {
      // Only adding is blocked; everything already there stays editable.
      if (this.form) this.closeForm(false);
      this.limitShown = true;
      this.render();
      return;
    }
    if (this.form) this.closeForm(false);
    const initial = countdownId === null ? null : (this.countdowns.find((countdown) => countdown.id === countdownId) ?? null);
    if (countdownId !== null && !initial) return;
    this.form = new CountdownForm(countdownId, initial, {
      submit: async (fields) => {
        if (countdownId === null) {
          const created = await this.actions.add(fields);
          this.closeForm(false);
          this.items.get(created.id)?.highlight();
          this.focusAdd();
        } else {
          await this.actions.update(countdownId, fields);
          this.closeForm(false);
          this.items.get(countdownId)?.editButton.focus();
        }
      },
      cancel: () => this.closeForm(true),
    });
    this.render();
    this.form.focus();
  }

  private closeForm(restoreFocus: boolean): void {
    const form = this.form;
    if (!form) return;
    this.form = null;
    const hadFocus = form.root.contains(document.activeElement);
    form.root.remove();
    this.render();
    if (!restoreFocus && !hadFocus) return;
    const item = form.countdownId ? this.items.get(form.countdownId) : undefined;
    if (restoreFocus && item) item.editButton.focus();
    else if (restoreFocus || hadFocus) this.focusAdd();
  }

  private async remove(id: string): Promise<void> {
    const name = this.countdowns.find((countdown) => countdown.id === id)?.name ?? 'countdown';
    try {
      const removed = await this.actions.remove(id);
      this.toast.show(`Deleted “${removed.name}”.`, {
        actionLabel: 'Undo',
        focusAction: true,
        onAction: () => void this.restore(removed),
      });
    } catch (error) {
      this.toast.show(`Couldn’t delete “${name}”: ${errorMessage(error)}`, { error: true });
    }
  }

  private async restore(countdown: Countdown): Promise<void> {
    try {
      await this.actions.restore(countdown);
      const item = this.items.get(countdown.id);
      item?.highlight();
      item?.editButton.focus();
    } catch (error) {
      this.toast.show(`Couldn’t restore “${countdown.name}”: ${errorMessage(error)}`, { error: true });
    }
  }
}
