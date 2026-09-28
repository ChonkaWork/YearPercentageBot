import { MASK_CATEGORY_INFO, maskSummary, type MaskedItem } from '../core/mask';
import { h } from './dom';
import { icon } from './icons';

/**
 * "3 items masked · Review" for a made prompt, shared by the panel and the popup. The review
 * lists category, a safe preview (never the value) and the placeholder, with "Undo masking for
 * this prompt". After an undo it says so and offers "Mask again".
 */
export interface MaskReviewOptions {
  items: readonly MaskedItem[];
  /** The prompt on the clipboard is the unmasked one. */
  undone: boolean;
  open: boolean;
  onToggle(open: boolean): void;
  onUndo(): void;
  onRedo(): void;
}

let ids = 0;

export function maskReview(options: MaskReviewOptions): HTMLElement | null {
  if (options.undone) {
    return h(
      'div',
      { class: 'mask-review undone', attrs: { role: 'status' } },
      h(
        'div',
        { class: 'mask-bar' },
        icon('shieldSlash'),
        h('span', { class: 'mask-summary', text: 'Masking undone for this prompt' }),
        h('button', { class: 'link-button', text: 'Mask again', attrs: { type: 'button', 'data-mask-again': '' }, on: { click: () => options.onRedo() } }),
      ),
      h('p', { class: 'mask-warning', text: 'The copied prompt has the original values. History keeps the masked one.' }),
    );
  }
  if (options.items.length === 0) return null;

  const detailsId = `pb-mask-details-${++ids}`;
  const toggle = h(
    'button',
    {
      class: 'link-button mask-toggle',
      attrs: { type: 'button', 'aria-expanded': String(options.open), 'aria-controls': detailsId },
      on: { click: () => options.onToggle(!options.open) },
    },
    h('span', { text: 'Review' }),
    icon(options.open ? 'chevronUp' : 'chevronDown'),
  );
  const list = h(
    'ul',
    { class: 'mask-list', attrs: { 'aria-label': 'Masked items' } },
    ...options.items.map((item) =>
      h(
        'li',
        {},
        h('span', { class: 'mask-category', text: MASK_CATEGORY_INFO[item.category].short }),
        h('code', { class: 'mask-preview', text: item.preview, attrs: { title: 'What was replaced (shortened)' } }),
        h(
          'span',
          { class: 'mask-to' },
          h('code', { class: 'mask-placeholder', text: item.placeholder }),
          item.count > 1 ? h('span', { class: 'mask-count', text: `×${item.count}` }) : null,
        ),
      ),
    ),
  );
  const details = h(
    'div',
    { class: 'mask-details', attrs: { id: detailsId } },
    list,
    h(
      'button',
      { class: 'link-button mask-undo', attrs: { type: 'button', 'data-undo-mask': '' }, on: { click: () => options.onUndo() } },
      icon('arrowCounterclockwise'),
      h('span', { text: 'Undo masking for this prompt' }),
    ),
  );
  details.hidden = !options.open;
  return h(
    'div',
    { class: 'mask-review' },
    h('div', { class: 'mask-bar' }, icon('shieldCheck'), h('span', { class: 'mask-summary', text: maskSummary(options.items) }), toggle),
    details,
  );
}

/** One line before anything is made: "Masks 3 items: API key, email, card". */
export function maskNote(items: readonly MaskedItem[]): HTMLElement | null {
  if (items.length === 0) return null;
  const kinds = [...new Set(items.map((item) => MASK_CATEGORY_INFO[item.category].noun))];
  return h(
    'p',
    { class: 'mask-note', attrs: { title: 'Replaced with placeholders like [EMAIL_1] before the prompt is made. Change it in settings.' } },
    icon('shieldCheck'),
    h('span', { text: `${items.length === 1 ? 'Masks 1 item' : `Masks ${items.length} items`}: ${kinds.join(', ')}` }),
  );
}
