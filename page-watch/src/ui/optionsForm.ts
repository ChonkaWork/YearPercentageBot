import { parseTarget } from '../core/numbers';
import { INTERVAL_MESSAGE, isIntervalAllowed, isRuleAllowed, ruleFeature, type Plan } from '../core/plan';
import type { ChangeMode, IntervalMinutes } from '../core/types';
import { isChangeMode, isInterval } from '../core/types';
import { cleanKeyword, cleanName, cleanTarget, MAX_KEYWORD_CHARS, MAX_NAME_CHARS, MAX_TARGET_CHARS, TARGET_MESSAGE } from '../core/watch';
import { h } from './dom';
import { INTERVAL_OPTIONS, MODE_OPTIONS, proBadge } from './format';

export interface OptionsValues {
  name: string;
  intervalMinutes: IntervalMinutes;
  mode: ChangeMode;
  keyword: string;
  target: string;
}

export interface OptionsForm {
  element: HTMLElement;
  values(): OptionsValues;
  /** A message for the first invalid field (and focuses it), or null. */
  validate(): string | null;
  setDisabled(disabled: boolean): void;
  focus(): void;
}

/** What the plan allows in the form. */
export interface PlanGate {
  plan: Plan;
  /** A watch's current interval and rule: they stay selectable on any plan. */
  keep?: { intervalMinutes: IntervalMinutes; mode: ChangeMode };
  /** Opens the "About Pro" card. */
  onAboutPro(): void;
}

function aboutProHint(text: string, gate: PlanGate, className = 'form-hint d-flex flex-wrap align-items-center gap-1 mt-1 mb-0'): HTMLElement {
  return h(
    'p',
    { class: `${className} pro-hint` },
    proBadge(),
    h('span', { text }),
    h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', text: 'About Pro', attrs: { type: 'button' }, on: { click: () => gate.onAboutPro() } }),
  );
}

/** Name, interval and change rule: used when adding a watch and when editing one. */
export function optionsForm(prefix: string, initial: OptionsValues, gate: PlanGate): OptionsForm {
  const intervalAllowed = (minutes: number) => isIntervalAllowed(gate.plan, minutes) || minutes === gate.keep?.intervalMinutes;
  const ruleAllowed = (mode: ChangeMode) => isRuleAllowed(gate.plan, mode) || mode === gate.keep?.mode;

  const name = h('input', {
    class: 'form-control form-control-sm',
    attrs: { id: `${prefix}-name`, type: 'text', maxlength: String(MAX_NAME_CHARS), autocomplete: 'off', 'data-focus': `${prefix}-name` },
  });
  name.value = initial.name;

  const interval = h('select', { class: 'form-select form-select-sm', attrs: { id: `${prefix}-interval`, 'data-focus': `${prefix}-interval` } });
  let lockedIntervals = false;
  for (const option of INTERVAL_OPTIONS) {
    const allowed = intervalAllowed(Number(option.value));
    const element = h('option', { text: allowed ? option.label : `${option.label} · PRO`, attrs: { value: option.value } });
    element.disabled = !allowed;
    lockedIntervals ||= !allowed;
    interval.append(element);
  }
  interval.value = String(initial.intervalMinutes);

  const keyword = h('input', {
    class: 'form-control form-control-sm mt-1',
    attrs: {
      id: `${prefix}-keyword`,
      type: 'text',
      maxlength: String(MAX_KEYWORD_CHARS),
      placeholder: 'e.g. In stock',
      autocomplete: 'off',
      'aria-label': 'Keyword',
      'data-focus': `${prefix}-keyword`,
    },
  });
  keyword.value = initial.keyword;

  const target = h('input', {
    class: 'form-control form-control-sm mt-1 mono',
    attrs: {
      id: `${prefix}-target`,
      type: 'text',
      maxlength: String(MAX_TARGET_CHARS),
      placeholder: 'e.g. 99.99 or $100',
      autocomplete: 'off',
      'aria-label': 'Target price',
      'data-focus': `${prefix}-target`,
    },
  });
  target.value = initial.target;

  let lockedRules = false;
  const radios = MODE_OPTIONS.map((option) => {
    const allowed = ruleAllowed(option.value);
    const input = h('input', {
      class: 'form-check-input',
      attrs: { type: 'radio', name: `${prefix}-mode`, id: `${prefix}-mode-${option.value}`, value: option.value, 'data-focus': `${prefix}-mode-${option.value}` },
    });
    input.checked = option.value === initial.mode;
    input.disabled = !allowed;
    input.dataset.locked = String(!allowed);
    lockedRules ||= !allowed;
    const label = h('label', { class: 'form-check-label', text: option.label, attrs: { for: input.id, title: option.help } });
    if (ruleFeature(option.value)) label.append(proBadge());
    const wrapper = h('div', { class: 'form-check' }, input, label);
    if (option.value === 'keyword') wrapper.append(keyword);
    if (option.value === 'below') wrapper.append(target);
    return input;
  });

  const syncFields = () => {
    const mode = radios.find((radio) => radio.checked)?.value;
    keyword.hidden = mode !== 'keyword';
    target.hidden = mode !== 'below';
  };
  for (const radio of radios) radio.addEventListener('change', syncFields);
  syncFields();

  const intervalField = h('div', {}, h('label', { class: 'form-label', text: 'Check every', attrs: { for: interval.id } }), interval);
  if (lockedIntervals) intervalField.append(aboutProHint(INTERVAL_MESSAGE, gate));
  const rules = h(
    'fieldset',
    { class: 'mode-options' },
    h('legend', { class: 'form-label mb-1', text: 'Notify me when' }),
    ...radios.map((radio) => radio.parentElement!),
  );
  if (lockedRules) rules.append(aboutProHint('Number, keyword and price rules are part of Pro.', gate));

  const element = h(
    'div',
    { class: 'vstack gap-2' },
    h('div', {}, h('label', { class: 'form-label', text: 'Name', attrs: { for: name.id } }), name),
    intervalField,
    rules,
  );

  const values = (): OptionsValues => {
    const mode = radios.find((radio) => radio.checked)?.value;
    const minutes = Number(interval.value);
    return {
      name: cleanName(name.value),
      intervalMinutes: isInterval(minutes) ? minutes : initial.intervalMinutes,
      mode: isChangeMode(mode) ? mode : 'text',
      keyword: cleanKeyword(keyword.value),
      target: cleanTarget(target.value),
    };
  };

  return {
    element,
    values,
    validate() {
      const current = values();
      if (!current.name) {
        name.focus();
        return 'Give the watch a name.';
      }
      if (current.mode === 'keyword' && !current.keyword) {
        keyword.focus();
        return 'Enter the keyword to look for.';
      }
      if (current.mode === 'below' && !parseTarget(current.target)) {
        target.focus();
        return TARGET_MESSAGE;
      }
      return null;
    },
    setDisabled(disabled) {
      for (const control of [name, interval, keyword, target]) control.disabled = disabled;
      for (const radio of radios) radio.disabled = disabled || radio.dataset.locked === 'true';
    },
    focus() {
      name.focus();
      name.select();
    },
  };
}
