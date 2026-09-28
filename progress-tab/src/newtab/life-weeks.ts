import {
  DEFAULT_LIFE_YEARS,
  MAX_LIFE_YEARS,
  MIN_BIRTH_YEAR,
  MIN_LIFE_YEARS,
  describeLife,
  validateLifeDraft,
  type LifeField,
  type LifeSettings,
  type LifeView,
} from '../core/life';
import { byId, h, setAttr, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';

/** Saves new life settings; resolves false when storage refused (the page shows why). */
export type SaveLife = (life: LifeSettings) => Promise<boolean>;

const GAP = 1;
const MAX_PITCH = 6;
const MIN_PITCH = 3;

/**
 * "Life in weeks" (Pro). One <canvas> draws every week (4,160 squares for 80 years) instead of
 * thousands of DOM nodes, and only when something visible changed: a new week, other settings,
 * the theme or the card's width. The same numbers are in a visible sentence and the canvas label.
 */
export class LifeWeeks {
  private readonly body = byId<HTMLDivElement>('life-body');
  private readonly editButton = byId<HTMLButtonElement>('life-edit');

  private readonly display: HTMLDivElement;
  private readonly percent = h('span', { class: 'life-percent' });
  private readonly caption = h('span', { class: 'life-caption' });
  private readonly canvas = h('canvas', { class: 'life-grid', attrs: { role: 'img' } });
  private readonly summary = h('p', { class: 'life-summary' });

  private readonly form: HTMLFormElement;
  private readonly birthInput = h('input', {
    class: 'form-control',
    attrs: { type: 'date', id: 'life-birth', min: `${MIN_BIRTH_YEAR}-01-01`, required: '', 'aria-describedby': 'life-birth-error life-privacy' },
  });
  private readonly yearsInput = h('input', {
    class: 'form-control',
    attrs: {
      type: 'number',
      id: 'life-years',
      min: String(MIN_LIFE_YEARS),
      max: String(MAX_LIFE_YEARS),
      step: '1',
      inputmode: 'numeric',
      'aria-describedby': 'life-years-error',
    },
  });
  private readonly feedback: Record<LifeField, HTMLDivElement> = {
    birthDate: h('div', { class: 'invalid-feedback', attrs: { id: 'life-birth-error' } }),
    years: h('div', { class: 'invalid-feedback', attrs: { id: 'life-years-error' } }),
  };
  private readonly saveError = h('div', { class: 'alert alert-danger alert-with-icon', attrs: { role: 'alert', hidden: '' } });
  private readonly cancelButton: HTMLButtonElement;
  private readonly forgetButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;

  private life: LifeSettings | null = null;
  private editing = false;
  private busy = false;
  private view: LifeView | null = null;
  private drawnKey = '';
  private colorsVersion = 0;

  constructor(private readonly save: SaveLife) {
    this.display = h(
      'div',
      { class: 'life-display' },
      h('div', { class: 'life-head' }, this.percent, this.caption),
      this.canvas,
      this.summary,
      h(
        'p',
        { class: 'life-legend' },
        'Each column is a year of your life, each square a week.',
        h('span', { class: 'life-legend-item' }, h('span', { class: 'life-key' }), 'lived'),
        h('span', { class: 'life-legend-item' }, h('span', { class: 'life-key life-key-now' }), 'this week'),
      ),
    );

    this.saveButton = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'submit' }, text: 'Show my weeks' });
    this.cancelButton = h('button', { class: 'btn btn-quiet btn-sm', attrs: { type: 'button' }, text: 'Cancel', on: { click: () => this.closeForm() } });
    this.forgetButton = h('button', {
      class: 'btn btn-link btn-sm link-danger ms-auto',
      attrs: { type: 'button' },
      text: 'Forget birth date',
      on: { click: () => void this.submit({ birthDate: null, years: this.life?.years ?? DEFAULT_LIFE_YEARS }) },
    });
    this.form = h(
      'form',
      {
        class: 'life-form',
        attrs: { novalidate: '', 'aria-label': 'Life in weeks setup' },
        on: {
          submit: (event) => {
            event.preventDefault();
            this.submitForm();
          },
          keydown: (event) => {
            if (event.key !== 'Escape' || !this.life?.birthDate) return;
            event.preventDefault();
            event.stopPropagation();
            this.closeForm();
          },
        },
      },
      h(
        'p',
        { class: 'life-privacy', attrs: { id: 'life-privacy' } },
        icon('shieldCheck'),
        h('span', { text: 'Your birth date is stored only in this browser and used only to draw this grid. It is never sent anywhere.' }),
      ),
      h(
        'div',
        { class: 'form-fields' },
        h('div', {}, h('label', { class: 'form-label', attrs: { for: 'life-birth' }, text: 'Birth date' }), this.birthInput, this.feedback.birthDate),
        h(
          'div',
          {},
          h('label', { class: 'form-label', attrs: { for: 'life-years' }, text: 'Expected span (years)' }),
          this.yearsInput,
          this.feedback.years,
        ),
      ),
      this.saveError,
      h('div', { class: 'form-actions' }, this.saveButton, this.cancelButton, this.forgetButton),
    );

    this.body.replaceChildren(this.display, this.form);
    this.editButton.addEventListener('click', () => this.openForm());
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  /** Called every second while visible. Cheap: a few date operations; the DOM and canvas are only touched on change. */
  update(now: Date, life: LifeSettings, decimals: number): void {
    if (this.life !== life) {
      this.life = life;
      if (!this.editing) this.fillForm(life);
    }
    this.view = describeLife(life, now, decimals);
    this.render();
  }

  /** The theme or accent changed: redraw with the new colors. */
  invalidateColors(): void {
    this.colorsVersion++;
    this.draw();
  }

  private render(): void {
    const showForm = this.editing || !this.life?.birthDate || !this.view;
    setHidden(this.form, !showForm);
    setHidden(this.display, showForm);
    setHidden(this.editButton, showForm);
    setHidden(this.cancelButton, !this.life?.birthDate);
    setHidden(this.forgetButton, !this.life?.birthDate);
    const view = this.view;
    if (showForm || !view) return;
    setText(this.percent, view.percent.text);
    setText(this.caption, view.caption);
    setText(this.summary, view.summary);
    setAttr(this.canvas, 'aria-label', `Life in weeks: ${view.summary}`);
    this.draw();
  }

  private draw(): void {
    const view = this.view;
    if (!view || this.display.hidden) return;
    const width = this.canvas.clientWidth;
    if (width === 0) return;
    const pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, Math.floor((width + GAP) / view.columns)));
    const cell = pitch - GAP;
    const height = view.rows * pitch - GAP;
    const ratio = window.devicePixelRatio || 1;
    const key = `${width}|${ratio}|${pitch}|${view.columns}|${view.filled}|${view.current}|${this.colorsVersion}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;

    const cssHeight = `${height}px`;
    if (this.canvas.style.height !== cssHeight) this.canvas.style.height = cssHeight;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const style = getComputedStyle(this.canvas);
    const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const lived = color('--pt-accent', '#0ca678');
    const future = color('--pt-track', '#e8eeeb');
    const now = color('--pt-accent-text', '#087f5b');

    const rect = (index: number) => {
      const column = Math.floor(index / view.rows);
      const row = index % view.rows;
      context.rect(column * pitch, row * pitch, cell, cell);
    };
    const total = view.columns * view.rows;
    // Three batched paths (lived, future, now) instead of 4,000 fill calls.
    context.beginPath();
    for (let index = 0; index < view.filled; index++) rect(index);
    context.fillStyle = lived;
    context.fill();
    context.beginPath();
    for (let index = view.filled + (view.current === null ? 0 : 1); index < total; index++) rect(index);
    context.fillStyle = future;
    context.fill();
    if (view.current !== null) {
      context.beginPath();
      const column = Math.floor(view.current / view.rows);
      const row = view.current % view.rows;
      // Slightly larger so this week stands out even at 3 px.
      context.rect(column * pitch - GAP, row * pitch - GAP, cell + 2 * GAP, cell + 2 * GAP);
      context.fillStyle = now;
      context.fill();
    }
  }

  private fillForm(life: LifeSettings): void {
    this.birthInput.value = life.birthDate ?? '';
    this.yearsInput.value = String(life.years);
    this.showErrors({});
    this.showSaveError(null);
  }

  private openForm(): void {
    if (this.life) this.fillForm(this.life);
    this.editing = true;
    this.saveButton.textContent = 'Save';
    this.render();
    this.birthInput.focus();
  }

  private closeForm(): void {
    const hadFocus = this.form.contains(document.activeElement);
    this.editing = false;
    if (this.life) this.fillForm(this.life);
    this.render();
    if (hadFocus && !this.editButton.hidden) this.editButton.focus();
  }

  private submitForm(): void {
    const result = validateLifeDraft(
      { birthDate: this.birthInput.value, years: this.yearsInput.value, birthDateIncomplete: this.birthInput.validity.badInput },
      new Date(),
    );
    this.showErrors(result.ok ? {} : result.errors);
    if (result.ok) void this.submit(result.value);
  }

  private async submit(life: LifeSettings): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.saveButton.disabled = true;
    this.showSaveError(null);
    // Stay in the form until it's saved, so nothing typed is lost if storage refuses.
    this.editing = true;
    const saved = await this.save(life);
    this.busy = false;
    this.saveButton.disabled = false;
    if (!saved) {
      this.showSaveError('Couldn’t save. Nothing was changed; please try again.');
      return;
    }
    const hadFocus = this.form.contains(document.activeElement);
    this.editing = false;
    this.fillForm(life);
    this.saveButton.textContent = life.birthDate ? 'Save' : 'Show my weeks';
    this.render();
    if (hadFocus) (this.editButton.hidden ? this.birthInput : this.editButton).focus();
  }

  private showErrors(errors: Partial<Record<LifeField, string>>): void {
    const inputs: Record<LifeField, HTMLInputElement> = { birthDate: this.birthInput, years: this.yearsInput };
    let first: HTMLInputElement | null = null;
    for (const field of ['birthDate', 'years'] as const) {
      const message = errors[field];
      inputs[field].classList.toggle('is-invalid', Boolean(message));
      if (message) inputs[field].setAttribute('aria-invalid', 'true');
      else inputs[field].removeAttribute('aria-invalid');
      this.feedback[field].textContent = message ?? '';
      if (message && !first) first = inputs[field];
    }
    first?.focus();
  }

  private showSaveError(message: string | null): void {
    this.saveError.replaceChildren(...(message ? [icon('exclamationTriangleFill'), h('span', { text: message })] : []));
    setHidden(this.saveError, !message);
  }
}
