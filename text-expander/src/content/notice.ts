/**
 * A small in-page toast for the rare case an expansion fails, so it never fails silently.
 * Lives in a closed shadow root (page CSS can't reach it) and is styled through
 * adoptedStyleSheets, which works under strict page CSPs.
 */

import alertIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import css from '../styles/inpage.scss?inline';
import { svgIcon } from '../ui/icons';

const VISIBLE_MS = 5000;
let host: HTMLElement | null = null;
let hideTimer: number | undefined;

export function showNotice(title: string, detail: string): void {
  // Only in the frame where it happened; tiny frames can't show it usefully.
  if (window.innerWidth < 240 || window.innerHeight < 80) return;
  host?.remove();
  window.clearTimeout(hideTimer);

  host = document.createElement('snippets-notice');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;';
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  root.adoptedStyleSheets = [sheet];

  const toast = document.createElement('div');
  toast.className = 'toast show';
  toast.setAttribute('role', 'alert');
  const body = document.createElement('div');
  body.className = 'toast-body';
  const brand = document.createElement('span');
  brand.className = 'notice-brand';
  brand.textContent = 'Snippets';
  const heading = document.createElement('strong');
  heading.className = 'notice-title';
  heading.textContent = title;
  const text = document.createElement('span');
  text.className = 'notice-detail';
  text.textContent = detail;
  const content = document.createElement('div');
  content.append(brand, heading, text);
  body.append(svgIcon(alertIcon, 'notice-icon'), content);
  toast.append(body);
  root.append(toast);
  (document.body ?? document.documentElement).append(host);

  hideTimer = window.setTimeout(() => {
    host?.remove();
    host = null;
  }, VISIBLE_MS);
}
