import basketIcon from 'bootstrap-icons/icons/basket.svg';
import removeIcon from 'bootstrap-icons/icons/x-lg.svg';
import { basketSheets, commonDecimal, itemHost, itemLabel, mergeBasket, mergedColumns, type BasketItem } from '../core/basket';
import { hasFeature, upgradeMessage } from '../core/plan';
import type { MergeLayout } from '../core/settings';
import { clearBasket, removeBasketItem } from '../storage/store';
import { byId, h } from '../ui/dom';
import { plural, tableSize } from '../ui/format';
import { svgIcon } from '../ui/icons';
import { aboutProLink, allowed, announce, emptyState, onSettingsChange, showNotice, state, updateSettings } from './context';
import { exportControl, type ExportJob } from './export';
import { fitPreviews, previewBlock } from './preview';

/**
 * The basket: tables collected from one or more pages, exported as one. Shows what the
 * merge will look like: a small preview, and which columns were matched by their header
 * in every table and which only some tables have (left empty for the others).
 */

const els = {
  basket: byId<HTMLDivElement>('basket'),
  count: byId<HTMLSpanElement>('basket-count'),
};

onSettingsChange(() => renderBasket());

export function renderBasket(): void {
  const basket = state.basket;
  els.count.hidden = basket.length === 0;
  els.count.textContent = String(basket.length);
  if (!hasFeature(state.plan, 'merge-tables')) {
    els.basket.replaceChildren(h('div', { class: 'empty-state' }, svgIcon(basketIcon, 22), h('span', {}, `${upgradeMessage('merge-tables')} `, aboutProLink())));
    return;
  }
  if (basket.length === 0) {
    els.basket.replaceChildren(emptyState(basketIcon, 'Add tables from this page or others with the basket button, then export them together as one table.'));
    return;
  }

  const items = basket.map((item, index) => {
    const label = itemLabel(item, index);
    const remove = h('button', { class: 'btn btn-icon btn-remove', attrs: { type: 'button', 'aria-label': `Remove ${label}`, title: 'Remove' } }, svgIcon(removeIcon, 12));
    remove.addEventListener('click', () => void removeItem(item.id));
    const meta = [tableSize(item.rows.length + 1, item.columns.length), itemHost(item)].filter(Boolean).join(' · ');
    return h(
      'li',
      { class: 'list-group-item basket-item d-flex align-items-center gap-2', attrs: { 'data-id': item.id } },
      h('div', { class: 'min-w-0 flex-grow-1' }, h('div', { class: 'basket-title text-truncate', text: label, attrs: { title: label } }), h('div', { class: 'basket-meta text-truncate', text: meta, attrs: { title: item.url } })),
      remove,
    );
  });

  const merged = mergeBasket(basket, { source: state.settings.mergeSource });
  const sourceSwitch = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', role: 'switch', id: 'merge-source' } });
  sourceSwitch.checked = state.settings.mergeSource;
  sourceSwitch.addEventListener('change', () => void updateSettings({ mergeSource: sourceSwitch.checked }));

  const layoutRadio = (value: MergeLayout, label: string) => {
    const id = `layout-${value}`;
    const input = h('input', { class: 'btn-check', attrs: { type: 'radio', name: 'merge-layout', id, value, autocomplete: 'off' } });
    input.checked = state.settings.mergeLayout === value;
    input.addEventListener('change', () => {
      if (input.checked) void updateSettings({ mergeLayout: value });
    });
    return [input, h('label', { class: 'btn btn-outline-secondary', text: label, attrs: { for: id } })];
  };

  const control = exportControl(basket.length === 1 ? 'the basket table' : `${basket.length} merged tables`, loadBasket);
  const clear = h('button', { class: 'btn btn-outline-danger btn-sm', text: 'Clear', attrs: { type: 'button', id: 'basket-clear' } });
  clear.addEventListener('click', () => void clearAll());

  const options = h(
    'div',
    { class: 'd-flex align-items-center flex-wrap gap-2 mb-2' },
    h('div', { class: 'form-check form-switch m-0' }, sourceSwitch, h('label', { class: 'form-check-label small', text: 'Source columns', attrs: { for: 'merge-source', title: 'Add "Source" and "Source URL" columns' } })),
  );
  // The sheet layout only matters for .xlsx files.
  if (state.settings.format === 'xlsx') {
    options.append(h('div', { class: 'btn-group btn-group-sm ms-auto layout-group', attrs: { role: 'group', 'aria-label': '.xlsx layout' } }, ...layoutRadio('stack', 'One sheet'), ...layoutRadio('sheets', 'Sheet per table')));
  }

  els.basket.replaceChildren(
    h('ul', { class: 'list-group list-group-flush basket-list' }, ...items),
    h(
      'div',
      { class: 'card-body p-3 border-top' },
      h(
        'div',
        { class: 'basket-summary d-flex align-items-baseline gap-2 mb-2', attrs: { id: 'basket-summary', tabindex: '-1' } },
        h('span', { class: 'section-label', text: 'Merged' }),
        h('span', { class: 'mono small', text: tableSize(merged.rows.length, merged.width) }),
      ),
      basketPreview(basket),
      columnReport(basket, state.settings.mergeSource),
      options,
      h('div', { class: 'd-flex gap-2 basket-actions' }, control.element, clear),
    ),
  );
  fitPreviews(els.basket);
}

/** The first merged rows, data columns only (the Source columns would fill the preview). */
function basketPreview(basket: readonly BasketItem[]): HTMLElement {
  const data = mergeBasket(basket, { source: false });
  return previewBlock({ rows: data.rows.slice(0, 4), headerRows: data.headerRows, columns: data.width }, 'basket-preview');
}

/** Every merged column as a chip: matched in all tables, or only in some (the rest stay empty). */
function columnReport(basket: readonly BasketItem[], source: boolean): HTMLElement {
  const columns = mergedColumns(basket);
  const total = basket.length;
  const partial = columns.filter((column) => column.tables.length < total).length;
  const chips = columns.map((column) => {
    const matched = column.tables.length === total;
    const tables = column.tables.map((index) => itemLabel(basket[index] as BasketItem, index)).join(', ');
    return h(
      'li',
      {
        class: `merge-column${matched ? ' is-matched' : ' is-partial'}`,
        attrs: { title: matched ? `In every table` : `Only in ${tables}; empty for the others` },
      },
      h('span', { class: 'merge-name', text: column.name }),
      h('span', { class: 'merge-count mono', text: `${column.tables.length}/${total}` }),
    );
  });
  const summary =
    total < 2
      ? 'Add tables with the same columns to stack them.'
      : partial === 0
        ? `All ${columns.length} columns matched by header.`
        : `${columns.length - partial} matched by header, ${partial} only in some tables (left empty elsewhere).`;
  const note = source ? `${summary} Source and Source URL come first.` : summary;
  return h('div', { class: 'merge-report mb-2' }, h('ul', { class: 'merge-columns list-unstyled', attrs: { 'aria-label': 'Merged columns' } }, ...chips), h('div', { class: 'merge-note', text: note }));
}

async function loadBasket(): Promise<ExportJob | null> {
  if (!allowed('merge-tables') || state.basket.length === 0) return null;
  const basket = state.basket;
  const options = { source: state.settings.mergeSource };
  return {
    name: `${basket.length} merged ${plural(basket.length, 'table')}`,
    file: basket.length === 1 ? itemLabel(basket[0] as BasketItem, 0) : 'merged tables',
    data: mergeBasket(basket, options),
    decimal: commonDecimal(basket) ?? '.',
    // Each sheet carries its pages' decimal separator; a stacked sheet mixing both keeps text.
    sheets: basketSheets(basket, { ...options, layout: state.settings.mergeLayout }),
  };
}

async function removeItem(id: string): Promise<void> {
  try {
    state.basket = await removeBasketItem(id);
  } catch {
    showNotice('error', "Couldn't update the basket", 'Please try again.');
    return;
  }
  renderBasket();
  announce(`Removed from the basket. ${state.basket.length} ${plural(state.basket.length, 'table')} left.`);
  els.basket.querySelector<HTMLElement>('.btn-remove, #basket-summary')?.focus();
}

async function clearAll(): Promise<void> {
  try {
    await clearBasket();
  } catch {
    showNotice('error', "Couldn't clear the basket", 'Please try again.');
    return;
  }
  state.basket = [];
  renderBasket();
  announce('The basket is empty.');
}
