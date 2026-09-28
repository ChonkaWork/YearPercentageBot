import downIcon from 'bootstrap-icons/icons/arrow-down.svg';
import upIcon from 'bootstrap-icons/icons/arrow-up.svg';
import gripIcon from 'bootstrap-icons/icons/grip-vertical.svg';
import searchIcon from 'bootstrap-icons/icons/search.svg';
import { columnLabels, columnSample, filterColumns, moveColumnTo, moveVisibleColumn, selectedColumns, type ColumnState } from '../core/columns';
import type { TableData } from '../core/table';
import { h } from '../ui/dom';
import { svgIcon } from '../ui/icons';
import { announce, proBadge } from './context';

/**
 * Column picker: switch columns on and off, filter the list, reorder with drag handles or
 * the arrow buttons (keyboard). Every copy, download and basket add of the table uses it.
 */

export interface PickerTarget {
  /** Unique per table, for element ids. */
  key: string;
  name: string;
  data: TableData;
  columns: ColumnState;
  /** Called after every change (the card updates its preview and buttons). */
  changed(): void;
}

interface PickerView {
  query: string;
  /** Column being dragged. */
  dragging: number | null;
}

type Focus = { column: number; control: 'up' | 'down' | 'check' | 'grip' } | { control: 'filter' };

export function createPicker(target: PickerTarget): HTMLElement {
  const picker = h('div', { class: 'column-picker mt-2', attrs: { role: 'group', 'aria-label': `Columns of ${target.name}` } });
  const view: PickerView = { query: '', dragging: null };
  renderPicker(picker, target, view);
  return picker;
}

function renderPicker(picker: HTMLElement, target: PickerTarget, view: PickerView, focus?: Focus): void {
  const { data, columns: state } = target;
  const labels = columnLabels(data);
  const samples = labels.map((_, column) => columnSample(data, column));
  const visible = filterColumns(labels, samples, view.query);
  const selected = selectedColumns(state).length;

  const update = (next?: Focus) => {
    renderPicker(picker, target, view, next);
    target.changed();
    announce(`${selectedColumns(state).length} of ${data.width} columns selected.`);
  };
  // All / None apply to the columns the filter shows.
  const setAll = (on: boolean) => {
    for (const column of state.order) {
      if (!visible.has(column)) continue;
      if (on) state.enabled.add(column);
      else state.enabled.delete(column);
    }
    update();
  };

  const shown = state.order.filter((column) => visible.has(column));
  const rows = shown.map((column, position) => {
    const id = `col-${target.key}-${column}`;
    const label = labels[column] ?? `Column ${column + 1}`;
    const checkbox = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', id, 'data-column': String(column) } });
    checkbox.checked = state.enabled.has(column);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.enabled.add(column);
      else state.enabled.delete(column);
      update({ column, control: 'check' });
    });
    const move = (step: -1 | 1) => {
      const button = h('button', {
        class: 'btn btn-icon btn-move',
        attrs: { type: 'button', 'data-move': step < 0 ? 'up' : 'down', 'aria-label': `Move ${label} ${step < 0 ? 'up' : 'down'}`, title: step < 0 ? 'Move up' : 'Move down' },
      });
      button.append(svgIcon(step < 0 ? upIcon : downIcon, 13));
      button.disabled = step < 0 ? position === 0 : position === shown.length - 1;
      button.addEventListener('click', () => {
        state.order = moveVisibleColumn(state.order, column, step, visible);
        update({ column, control: step < 0 ? 'up' : 'down' });
      });
      return button;
    };
    // The handle starts a drag of the whole row; the arrows do the same from the keyboard.
    const grip = h('span', { class: 'drag-handle', attrs: { 'aria-hidden': 'true', title: 'Drag to reorder' } }, svgIcon(gripIcon, 14));
    const row = h(
      'li',
      { class: `picker-row${state.enabled.has(column) ? '' : ' is-off'}`, attrs: { 'data-column': String(column) } },
      grip,
      checkbox,
      h('label', { class: 'picker-label', attrs: { for: id } }, h('span', { class: 'picker-name', text: label, attrs: { title: label } }), samples[column] ? h('span', { class: 'picker-sample', text: samples[column] ?? '' }) : null),
      move(-1),
      move(1),
    );
    grip.addEventListener('pointerdown', () => (row.draggable = true));
    grip.addEventListener('pointerup', () => (row.draggable = false));
    row.addEventListener('dragstart', (event) => {
      view.dragging = column;
      row.classList.add('is-dragging');
      event.dataTransfer?.setData('text/plain', label);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      view.dragging = null;
      for (const other of picker.querySelectorAll('.drop-before, .drop-after, .is-dragging')) other.classList.remove('drop-before', 'drop-after', 'is-dragging');
    });
    row.addEventListener('dragover', (event) => {
      if (view.dragging === null || view.dragging === column) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      for (const other of picker.querySelectorAll('.drop-before, .drop-after')) if (other !== row) other.classList.remove('drop-before', 'drop-after');
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', (event) => {
      if (!(event.relatedTarget instanceof Node && row.contains(event.relatedTarget))) row.classList.remove('drop-before', 'drop-after');
    });
    row.addEventListener('drop', (event) => {
      const dragged = view.dragging;
      if (dragged === null) return;
      event.preventDefault();
      const after = row.classList.contains('drop-after');
      const next = after ? (state.order[state.order.indexOf(column) + 1] ?? null) : column;
      state.order = moveColumnTo(state.order, dragged, next);
      view.dragging = null;
      update({ column: dragged, control: 'grip' });
      announce(`Moved ${labels[dragged] ?? 'the column'}.`);
    });
    return row;
  });

  const filter = h('input', {
    class: 'form-control form-control-sm picker-filter',
    attrs: { type: 'search', placeholder: 'Filter columns', 'aria-label': `Filter the columns of ${target.name}`, autocomplete: 'off', spellcheck: 'false' },
  });
  filter.value = view.query;
  filter.addEventListener('input', () => {
    view.query = filter.value;
    renderPicker(picker, target, view, { control: 'filter' });
  });

  const list =
    rows.length > 0
      ? h('ul', { class: 'picker-list list-unstyled m-0' }, ...rows)
      : h('div', { class: 'picker-empty', text: `No column matches "${view.query.trim()}".` });

  picker.replaceChildren(
    h(
      'div',
      { class: 'd-flex align-items-center gap-2 picker-head' },
      h('span', { class: 'section-label', text: 'Columns' }),
      proBadge(),
      h('span', { class: 'picker-count mono', text: `${selected} of ${data.width}` }),
      h('button', { class: 'btn btn-link btn-sm p-0 ms-auto', text: 'All', attrs: { type: 'button', 'data-select': 'all' }, on: { click: () => setAll(true) } }),
      h('button', { class: 'btn btn-link btn-sm p-0', text: 'None', attrs: { type: 'button', 'data-select': 'none' }, on: { click: () => setAll(false) } }),
    ),
    h('div', { class: 'picker-search' }, svgIcon(searchIcon, 12), filter),
    list,
  );

  // Keep keyboard focus on the control that was used, now in its new place.
  if (focus?.control === 'filter') {
    const input = picker.querySelector<HTMLInputElement>('.picker-filter');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  } else if (focus) {
    const row = picker.querySelector(`li[data-column="${focus.column}"]`);
    const target =
      focus.control === 'check' || focus.control === 'grip'
        ? row?.querySelector<HTMLElement>('input')
        : (row?.querySelector<HTMLButtonElement>(`[data-move="${focus.control}"]:not(:disabled)`) ?? row?.querySelector<HTMLElement>('button:not(:disabled)'));
    target?.focus();
  }
}
