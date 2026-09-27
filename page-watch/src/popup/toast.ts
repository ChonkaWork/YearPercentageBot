import { h, icon } from '../ui/dom';
import { ICONS } from '../ui/icons';

/** Bootstrap toast (markup only, no Bootstrap JS): success or error, auto-hides. */
export function showToast(container: HTMLElement, message: string, tone: 'success' | 'danger' = 'success'): void {
  const close = h('button', { class: 'btn-close btn-close-sm ms-auto', attrs: { type: 'button', 'aria-label': 'Close' } });
  const toast = h(
    'div',
    { class: 'toast show', attrs: { role: tone === 'danger' ? 'alert' : 'status' } },
    h(
      'div',
      { class: 'toast-body d-flex align-items-center gap-2' },
      icon(tone === 'success' ? ICONS.success : ICONS.danger, { class: `text-${tone}` }),
      h('span', { class: 'min-w-0', text: message }),
      close,
    ),
  );
  const remove = () => toast.remove();
  close.addEventListener('click', remove);
  container.replaceChildren(toast);
  window.setTimeout(remove, tone === 'success' ? 3500 : 7000);
}
