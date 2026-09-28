import checkIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import infoIcon from 'bootstrap-icons/icons/info-circle-fill.svg';
import closeIcon from 'bootstrap-icons/icons/x-lg.svg';
import { svgIcon } from '../ui/icons';
import { createShadowHost } from './shadow';

/**
 * A small confirmation in the corner of the page after a copy. Lives in a closed shadow
 * root (open in the e2e build) so the page's CSS can't touch it and it can't touch the
 * page. Page content only ever reaches it as text.
 */

export interface ToastMessage {
  tone: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
}

export const TOAST_TAG = 'table-copy-toast';
const DURATION_MS = { success: 2600, info: 4000, error: 6000 } as const;

let timer: number | undefined;

export function showToast(message: ToastMessage): void {
  // A copy injected before an extension update may have left its host behind.
  for (const stale of Array.from(document.querySelectorAll(TOAST_TAG))) stale.remove();
  window.clearTimeout(timer);

  const { host, root } = createShadowHost(TOAST_TAG);

  const toast = document.createElement('div');
  toast.className = `toast show tc-toast tc-${message.tone}`;
  toast.setAttribute('role', message.tone === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', message.tone === 'error' ? 'assertive' : 'polite');
  toast.setAttribute('aria-atomic', 'true');

  const icon = svgIcon(message.tone === 'success' ? checkIcon : message.tone === 'error' ? errorIcon : infoIcon, 18);
  icon.classList.add('tc-icon');

  const text = document.createElement('div');
  text.className = 'tc-text';
  const title = document.createElement('div');
  title.className = 'tc-title';
  title.textContent = message.title;
  text.append(title);
  if (message.detail) {
    const detail = document.createElement('div');
    detail.className = 'tc-detail';
    detail.textContent = message.detail;
    text.append(detail);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tc-close';
  close.setAttribute('aria-label', 'Close');
  close.append(svgIcon(closeIcon, 12));
  close.addEventListener('click', () => host.remove());

  const body = document.createElement('div');
  body.className = 'toast-body tc-body';
  body.append(icon, text, close);
  toast.append(body);
  root.append(toast);
  document.documentElement.append(host);

  let hovered = false;
  toast.addEventListener('mouseenter', () => (hovered = true));
  toast.addEventListener('mouseleave', () => {
    hovered = false;
    schedule();
  });
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!hovered) host.remove();
    }, DURATION_MS[message.tone]);
  };
  schedule();
}
