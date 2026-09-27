import type { ChangeMode, IntervalMinutes } from '../core/types';
import { isChangeMode, isInterval } from '../core/types';
import { cleanKeyword, cleanName, MAX_KEYWORD_CHARS, MAX_NAME_CHARS } from '../core/watch';
import { h } from './dom';
import { INTERVAL_OPTIONS, MODE_OPTIONS } from './format';

export interface OptionsValues {
  name: string;
  intervalMinutes: IntervalMinutes;
  mode: ChangeMode;
  keyword: string;
}

export interface OptionsForm {
  element: HTMLElement;
  values(): OptionsValues;
  /** A message for the first invalid field (and focuses it), or null. */
  validate(): string | null;
  setDisabled(disabled: boolean): void;
  focus(): void;
}

/** Name, interval and change rule: used when adding a watch and when editing one. */
export function optionsForm(prefix: string, initial: OptionsValues): OptionsForm {
  const name = h('input', {
    class: 'form-control form-control-sm',
    attrs: { id: `${prefix}-name`, type: 'text', maxlength: String(MAX_NAME_CHARS), autocomplete: 'off', 'data-focus': `${prefix}-name` },
  });
  name.value = initial.name;

  const interval = h('select', { class: 'form-select form-select-sm', attrs: { id: `${prefix}-interval`, 'data-focus': `${prefix}-interval` } });
  for (const option of INTERVAL_OPTIONS) interval.append(h('option', { text: option.label, attrs: { value: option.value } }));
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

  const radios = MODE_OPTIONS.map((option) => {
    const input = h('input', {
      class: 'form-check-input',
      attrs: { type: 'radio', name: `${prefix}-mode`, id: `${prefix}-mode-${option.value}`, value: option.value, 'data-focus': `${prefix}-mode-${option.value}` },
    });
    input.checked = option.value === initial.mode;
    const wrapper = h(
      'div',
      { class: 'form-check' },
      input,
      h('label', { class: 'form-check-label', text: option.label, attrs: { for: input.id, title: option.help } }),
    );
    if (option.value === 'keyword') wrapper.append(keyword);
    return input;
  });

  const syncKeyword = () => {
    const keywordMode = radios.find((radio) => radio.checked)?.value === 'keyword';
    keyword.hidden = !keywordMode;
  };
  for (const radio of radios) radio.addEventListener('change', syncKeyword);
  syncKeyword();

  const element = h(
    'div',
    { class: 'vstack gap-2' },
    h('div', {}, h('label', { class: 'form-label', text: 'Name', attrs: { for: name.id } }), name),
    h('div', {}, h('label', { class: 'form-label', text: 'Check every', attrs: { for: interval.id } }), interval),
    h(
      'fieldset',
      { class: 'mode-options' },
      h('legend', { class: 'form-label mb-1', text: 'Notify me when' }),
      ...radios.map((radio) => radio.parentElement!),
    ),
  );

  const values = (): OptionsValues => {
    const mode = radios.find((radio) => radio.checked)?.value;
    const minutes = Number(interval.value);
    return {
      name: cleanName(name.value),
      intervalMinutes: isInterval(minutes) ? minutes : initial.intervalMinutes,
      mode: isChangeMode(mode) ? mode : 'text',
      keyword: cleanKeyword(keyword.value),
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
      return null;
    },
    setDisabled(disabled) {
      for (const control of [name, interval, keyword, ...radios]) control.disabled = disabled;
    },
    focus() {
      name.focus();
      name.select();
    },
  };
}
