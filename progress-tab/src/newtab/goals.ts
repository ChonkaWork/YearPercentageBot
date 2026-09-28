import {
  GOAL_PERIODS,
  MAX_GOAL_NAME_LENGTH,
  MAX_UNIT_LENGTH,
  describeGoal,
  goalPeriodLabel,
  periodOver,
  validateGoalDraft,
  type Goal,
  type GoalErrors,
  type GoalField,
  type GoalFields,
  type GoalPeriod,
  type GoalStatus,
} from '../core/goals';
import { errorMessage, h, placeChildren, setAttr, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import type { ListLimit } from './countdowns';
import { createBar, updateBar, type Bar } from './progress';
import type { Toast } from './toast';

/** Storage operations; each resolves once the change is saved and throws when it isn't. */
export interface GoalActions {
  add(fields: GoalFields): Promise<Goal>;
  update(id: string, fields: GoalFields): Promise<void>;
  /** +1 / −1. Resolves with the saved goal. */
  step(id: string, delta: number): Promise<Goal>;
  /** Resolves with the deleted goal and where it was, for undo. */
  remove(id: string): Promise<{ goal: Goal; index: number }>;
  restore(goal: Goal, index: number): Promise<void>;
  reload(): void;
  aboutPro(): void;
}

type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

const PERIOD_LABELS: Record<GoalPeriod, string> = { year: 'This year', quarter: 'This quarter', month: 'This month', custom: 'Dates' };

const STATUS_CLASS: Record<GoalStatus, string> = {
  behind: 'is-behind',
  'on-pace': 'is-good',
  ahead: 'is-good',
  reached: 'is-good',
  missed: 'is-muted',
  upcoming: 'is-muted',
};

// --- One goal ----------------------------------------------------------------------------------

class GoalItem {
  readonly root: HTMLLIElement;
  readonly editButton: HTMLButtonElement;
  readonly plusButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly minusButton: HTMLButtonElement;
  private readonly stepper: HTMLDivElement;
  private readonly name = h('h3', { class: 'goal-name' });
  private readonly countText = h('span', { class: 'goal-count' });
  private readonly verdict = h('span', { class: 'goal-verdict' });
  private readonly period = h('span', { class: 'goal-period' });
  private readonly bar: Bar = createBar('Goal progress');
  private readonly marker = h('span', { class: 'goal-marker', attrs: { 'aria-hidden': 'true' } });
  private markerLeft = '';

  constructor(
    readonly id: string,
    handlers: { edit(id: string): void; remove(id: string): void; step(id: string, delta: number): void },
  ) {
    const button = (className: string, label: string, content: Node | string, onClick: () => void) =>
      h('button', { class: className, attrs: { type: 'button', title: label }, on: { click: onClick } }, content);
    this.editButton = button('btn-icon btn-sm', 'Edit', icon('pencil'), () => handlers.edit(id));
    this.deleteButton = button('btn-icon btn-sm', 'Delete', icon('trash3'), () => handlers.remove(id));
    this.minusButton = button('btn btn-quiet btn-sm btn-step', 'One less', '−1', () => handlers.step(id, -1));
    this.plusButton = button('btn btn-quiet btn-sm btn-step', 'One more', '+1', () => handlers.step(id, 1));
    this.stepper = h('div', { class: 'goal-stepper', attrs: { role: 'group' } }, this.minusButton, this.plusButton);
    this.root = h(
      'li',
      { class: 'list-group-item goal', attrs: { 'data-id': id } },
      this.name,
      h('div', { class: 'goal-controls' }, h('div', { class: 'row-actions' }, this.editButton, this.deleteButton), this.stepper),
      h('div', { class: 'goal-track' }, this.bar.track, this.marker),
      h('p', { class: 'goal-summary' }, this.countText, h('span', { class: 'goal-dot', attrs: { 'aria-hidden': 'true' }, text: ' · ' }), this.verdict),
      this.period,
    );
  }

  update(goal: Goal, now: Date): void {
    const view = describeGoal(goal, now);
    const quoted = `“${goal.name}”`;
    setText(this.name, goal.name);
    setAttr(this.editButton, 'aria-label', `Edit ${quoted}`);
    setAttr(this.deleteButton, 'aria-label', `Delete ${quoted}`);
    setAttr(this.minusButton, 'aria-label', `One less for ${quoted}`);
    setAttr(this.plusButton, 'aria-label', `One more for ${quoted}`);
    setAttr(this.stepper, 'aria-label', `Count for ${quoted}`);
    const atZero = goal.count <= 0;
    if (this.minusButton.disabled !== atZero) this.minusButton.disabled = atZero;
    if (!view) {
      setText(this.verdict, 'Invalid dates');
      return;
    }
    setAttr(this.root, 'data-status', view.status);
    setText(this.countText, view.countText);
    setText(this.verdict, view.verdict);
    setAttr(this.verdict, 'class', `goal-verdict ${STATUS_CLASS[view.status]}`);
    setText(this.period, view.periodLabel);
    setAttr(this.bar.track, 'aria-label', goal.name);
    updateBar(this.bar, view.fraction, view.percent.value, `${view.summary}. ${view.paceText}.`);
    const left = `${Math.round(view.elapsed * 10_000) / 100}%`;
    if (left !== this.markerLeft) {
      // CSSOM, not a style attribute: the page CSP forbids inline styles in markup.
      this.marker.style.left = left;
      this.markerLeft = left;
    }
    setAttr(this.marker, 'title', view.paceText);
  }

  highlight(): void {
    this.root.classList.add('is-new');
    requestAnimationFrame(() => requestAnimationFrame(() => this.root.classList.remove('is-new')));
  }
}

// --- Add / edit form ---------------------------------------------------------------------------

let formCount = 0;

interface FormHandlers {
  submit(fields: GoalFields): Promise<void>;
  cancel(): void;
}

class GoalForm {
  readonly root: HTMLLIElement;
  private readonly form: HTMLFormElement;
  private readonly inputs: Record<GoalField, HTMLInputElement>;
  private readonly feedback: Record<GoalField, HTMLDivElement>;
  private readonly periodInputs = new Map<GoalPeriod, HTMLInputElement>();
  private readonly customDates: HTMLDivElement;
  private readonly saveError = h('div', { class: 'alert alert-danger alert-with-icon', attrs: { role: 'alert', hidden: '' } });
  private readonly saveButton: HTMLButtonElement;
  private busy = false;

  constructor(
    /** null for a new goal. */
    readonly goalId: string | null,
    private readonly initial: Goal | null,
    private readonly handlers: FormHandlers,
  ) {
    const prefix = `goal-form-${++formCount}`;
    this.inputs = {
      name: h('input', { attrs: { type: 'text', maxlength: String(MAX_GOAL_NAME_LENGTH), autocomplete: 'off', placeholder: 'e.g. Read 24 books', required: '' } }),
      target: h('input', { attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '24', required: '' } }),
      unit: h('input', { attrs: { type: 'text', maxlength: String(MAX_UNIT_LENGTH), autocomplete: 'off', placeholder: 'books' } }),
      count: h('input', { attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '0' } }),
      start: h('input', { attrs: { type: 'date', min: '1000-01-01', max: '9999-12-31' } }),
      end: h('input', { attrs: { type: 'date', min: '1000-01-01', max: '9999-12-31' } }),
    };
    this.feedback = {
      name: h('div', { class: 'invalid-feedback' }),
      target: h('div', { class: 'invalid-feedback' }),
      unit: h('div', { class: 'invalid-feedback' }),
      count: h('div', { class: 'invalid-feedback' }),
      start: h('div', { class: 'invalid-feedback' }),
      end: h('div', { class: 'invalid-feedback' }),
    };
    const field = (name: GoalField, label: Node | string) => {
      const input = this.inputs[name];
      input.id = `${prefix}-${name}`;
      input.className = 'form-control';
      this.feedback[name].id = `${prefix}-${name}-error`;
      input.setAttribute('aria-describedby', this.feedback[name].id);
      return h('div', { class: `field-${name}` }, h('label', { class: 'form-label', attrs: { for: input.id } }, label), input, this.feedback[name]);
    };
    const optional = (text: string) => h('span', {}, `${text} `, h('span', { class: 'text-body-secondary fw-normal', text: '(optional)' }));

    const periods = h('div', { class: 'btn-group btn-group-sm goal-periods' });
    for (const period of GOAL_PERIODS) {
      const id = `${prefix}-period-${period}`;
      const input = h('input', {
        class: 'btn-check',
        attrs: { type: 'radio', name: `${prefix}-period`, id, value: period, autocomplete: 'off' },
        on: { change: () => this.showCustomDates() },
      });
      this.periodInputs.set(period, input);
      periods.append(input, h('label', { class: 'btn btn-segment', attrs: { for: id }, text: PERIOD_LABELS[period] }));
    }
    this.customDates = h('div', { class: 'form-fields goal-dates' }, field('start', 'First day'), field('end', 'Last day'));

    this.inputs.name.value = initial?.name ?? '';
    this.inputs.target.value = initial ? String(initial.target) : '';
    this.inputs.unit.value = initial?.unit ?? '';
    this.inputs.count.value = initial ? String(initial.count) : '';
    this.inputs.start.value = initial?.start ?? '';
    this.inputs.end.value = initial?.end ?? '';
    const period = this.periodInputs.get(initial?.period ?? 'year');
    if (period) period.checked = true;

    this.saveButton = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'submit' }, text: initial ? 'Save' : 'Add goal' });
    const cancel = h('button', { class: 'btn btn-quiet btn-sm', attrs: { type: 'button' }, text: 'Cancel', on: { click: () => this.handlers.cancel() } });

    this.form = h(
      'form',
      {
        attrs: { novalidate: '', 'aria-label': initial ? `Edit “${initial.name}”` : 'New goal' },
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
      field('name', 'Goal'),
      h('div', { class: 'form-fields goal-numbers' }, field('target', 'Target'), field('unit', optional('Unit')), field('count', 'Done so far')),
      h('fieldset', { class: 'goal-period-field' }, h('legend', { class: 'form-label', text: 'Period' }), periods),
      // Editing a year / quarter / month goal whose period is over: saving starts the current one.
      initial && initial.period !== 'custom' && periodOver(initial, new Date())
        ? h('p', {
            class: 'form-text goal-period-note',
            text: `${goalPeriodLabel(initial)} is over. Saving starts this goal again for the current ${initial.period}; set “Done so far” to 0 to start from scratch.`,
          })
        : null,
      this.customDates,
      this.saveError,
      h('div', { class: 'form-actions' }, this.saveButton, cancel, h('span', { class: 'form-hint', text: 'Enter saves · Esc cancels' })),
    );
    this.root = h('li', { class: 'list-group-item goal-form', attrs: { 'data-id': goalId ?? 'new' } }, this.form);
    this.showCustomDates();
  }

  focus(): void {
    this.inputs.name.focus({ preventScroll: true });
    this.root.scrollIntoView({ block: 'nearest' });
  }

  private get period(): GoalPeriod {
    for (const [period, input] of this.periodInputs) if (input.checked) return period;
    return 'year';
  }

  private showCustomDates(): void {
    setHidden(this.customDates, this.period !== 'custom');
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const result = validateGoalDraft(
      {
        name: this.inputs.name.value,
        unit: this.inputs.unit.value,
        target: this.inputs.target.value,
        count: this.inputs.count.value,
        period: this.period,
        start: this.inputs.start.value,
        end: this.inputs.end.value,
        startIncomplete: this.inputs.start.validity.badInput,
        endIncomplete: this.inputs.end.validity.badInput,
      },
      new Date(),
      this.initial ?? undefined,
    );
    this.showErrors(result.ok ? {} : result.errors);
    this.showSaveError(null);
    if (!result.ok) return;
    this.setBusy(true);
    try {
      await this.handlers.submit(result.value);
    } catch (error) {
      this.showSaveError(`Couldn’t save the goal: ${errorMessage(error)}`);
      this.setBusy(false);
    }
  }

  private showErrors(errors: GoalErrors): void {
    let first: HTMLInputElement | null = null;
    for (const name of ['name', 'target', 'unit', 'count', 'start', 'end'] as const) {
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

/**
 * The Goals card: each goal's count against the pace of its period, +1 / −1 right on the row,
 * add / edit / delete (with undo) like countdowns.
 */
export class GoalsSection {
  private readonly list = h('ul', { class: 'list-group list-group-flush goal-list' });
  private readonly empty: HTMLDivElement;
  private readonly emptyAdd: HTMLButtonElement;
  private readonly loading: HTMLDivElement;
  private readonly error: HTMLDivElement;
  private readonly errorText = h('span');
  private readonly limitNote: HTMLDivElement;
  private readonly limitText = h('span');
  private readonly limitLink: HTMLButtonElement;
  /** Announces the new count after +1 / −1 (the row itself doesn't live-update for screen readers). */
  private readonly announcer = h('p', { class: 'visually-hidden', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });
  private limit: ListLimit = { max: Number.POSITIVE_INFINITY, message: '', upgradable: false };
  private limitShown = false;
  private readonly items = new Map<string, GoalItem>();
  private goals: Goal[] = [];
  private state: LoadState = { kind: 'loading' };
  private showSkeleton = false;
  private form: GoalForm | null = null;
  private now = new Date();

  constructor(
    private readonly section: HTMLElement,
    body: HTMLElement,
    private readonly addButton: HTMLButtonElement,
    private readonly actions: GoalActions,
    private readonly toast: Toast,
  ) {
    this.emptyAdd = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'button' }, on: { click: () => this.openForm(null) } }, icon('plusLg'), ' Add goal');
    this.empty = h(
      'div',
      { class: 'goals-empty' },
      h('span', { class: 'empty-icon' }, icon('bullseye')),
      h('p', { text: 'Set a goal, like “Read 24 books”, and see whether you’re on pace for the year.' }),
      this.emptyAdd,
    );
    this.loading = h(
      'div',
      { class: 'goals-loading placeholder-glow', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'placeholder sk-wide' }),
      h('span', { class: 'placeholder sk-narrow' }),
    );
    this.error = h(
      'div',
      { class: 'alert alert-danger goals-error', attrs: { role: 'alert' } },
      h('p', { class: 'mb-2' }, h('strong', { text: 'Couldn’t load your goals. ' }), this.errorText),
      h('button', { class: 'btn btn-danger btn-sm', attrs: { type: 'button' }, text: 'Try again', on: { click: () => this.actions.reload() } }),
    );
    this.limitLink = h('button', { class: 'btn btn-link btn-sm link-inline', attrs: { type: 'button' }, text: 'About Pro', on: { click: () => this.actions.aboutPro() } });
    this.limitNote = h('div', { class: 'list-limit', attrs: { role: 'status' } }, icon('infoCircle'), h('p', {}, this.limitText, ' ', this.limitLink));
    body.replaceChildren(this.loading, this.error, this.empty, this.list, this.limitNote, this.announcer);
    addButton.addEventListener('click', () => this.openForm(null));
    setTimeout(() => {
      this.showSkeleton = true;
      this.render();
    }, 150);
    this.render();
  }

  setLimit(limit: ListLimit): void {
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

  setGoals(goals: Goal[]): void {
    this.goals = goals;
    this.state = { kind: 'ready' };
    if (this.form?.goalId && !goals.some((goal) => goal.id === this.form?.goalId)) {
      this.closeForm(false);
      this.toast.show('The goal you were editing was deleted in another tab.', { returnFocus: () => this.focusAdd() });
    }
    this.render();
  }

  /** Called every second: the pace moves with the calendar. */
  update(now: Date): void {
    this.now = now;
    this.render();
  }

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
      for (const element of [this.limitNote, this.empty, this.list, this.addButton]) setHidden(element, true);
      return;
    }

    if (this.goals.length < this.limit.max) this.limitShown = false;
    setHidden(this.limitNote, !this.limitShown);
    if (this.limitShown) {
      setText(this.limitText, this.limit.message);
      setHidden(this.limitLink, !this.limit.upgradable);
    }

    const nothing = this.goals.length === 0 && !this.form;
    setHidden(this.empty, !nothing);
    setHidden(this.addButton, nothing || this.form?.goalId === null);
    setHidden(this.list, nothing);

    const ids = new Set(this.goals.map((goal) => goal.id));
    for (const [id, item] of this.items) {
      if (ids.has(id)) continue;
      item.root.remove();
      this.items.delete(id);
    }
    const nodes: HTMLElement[] = [];
    if (this.form && this.form.goalId === null) nodes.push(this.form.root);
    // In the order they were added: a goal list is a plan, not a queue.
    for (const goal of this.goals) {
      let item = this.items.get(goal.id);
      if (!item) {
        item = new GoalItem(goal.id, {
          edit: (id) => this.openForm(id),
          remove: (id) => void this.remove(id),
          step: (id, delta) => void this.step(id, delta),
        });
        this.items.set(goal.id, item);
      }
      item.update(goal, this.now);
      nodes.push(this.form?.goalId === goal.id ? this.form.root : item.root);
    }
    placeChildren(this.list, nodes);
  }

  private openForm(goalId: string | null): void {
    if (goalId === null && this.goals.length >= this.limit.max) {
      // Only adding is blocked; every goal already there stays editable.
      if (this.form) this.closeForm(false);
      this.limitShown = true;
      this.render();
      return;
    }
    if (this.form) this.closeForm(false);
    const initial = goalId === null ? null : (this.goals.find((goal) => goal.id === goalId) ?? null);
    if (goalId !== null && !initial) return;
    this.form = new GoalForm(goalId, initial, {
      submit: async (fields) => {
        if (goalId === null) {
          const created = await this.actions.add(fields);
          this.closeForm(false);
          this.items.get(created.id)?.highlight();
          this.focusAdd();
        } else {
          await this.actions.update(goalId, fields);
          this.closeForm(false);
          this.items.get(goalId)?.editButton.focus();
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
    const item = form.goalId ? this.items.get(form.goalId) : undefined;
    if (restoreFocus && item) item.editButton.focus();
    else if (restoreFocus || hadFocus) this.focusAdd();
  }

  private async step(id: string, delta: number): Promise<void> {
    try {
      const goal = await this.actions.step(id, delta);
      const view = describeGoal(goal, this.now);
      if (view) this.announcer.textContent = `${goal.name}: ${view.summary}.`;
    } catch (error) {
      const name = this.goals.find((goal) => goal.id === id)?.name ?? 'goal';
      this.toast.show(`Couldn’t update “${name}”: ${errorMessage(error)}`, { error: true, returnFocus: () => this.focusAdd() });
    }
  }

  private async remove(id: string): Promise<void> {
    const name = this.goals.find((goal) => goal.id === id)?.name ?? 'goal';
    try {
      const { goal: removed, index } = await this.actions.remove(id);
      this.toast.show(`Deleted “${removed.name}”.`, {
        actionLabel: 'Undo',
        focusAction: true,
        onAction: () => void this.restore(removed, index),
        returnFocus: () => this.focusAdd(),
      });
    } catch (error) {
      this.toast.show(`Couldn’t delete “${name}”: ${errorMessage(error)}`, { error: true, returnFocus: () => this.focusAdd() });
    }
  }

  private async restore(goal: Goal, index: number): Promise<void> {
    try {
      await this.actions.restore(goal, index);
      const item = this.items.get(goal.id);
      item?.highlight();
      item?.editButton.focus();
    } catch (error) {
      this.toast.show(`Couldn’t restore “${goal.name}”: ${errorMessage(error)}`, { error: true, returnFocus: () => this.focusAdd() });
    }
  }
}
