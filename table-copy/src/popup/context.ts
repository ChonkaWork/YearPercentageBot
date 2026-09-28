import checkIcon from 'bootstrap-icons/icons/check2.svg';
import successIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import warningIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import infoIcon from 'bootstrap-icons/icons/info-circle-fill.svg';
import lockIcon from 'bootstrap-icons/icons/lock-fill.svg';
import type { BasketItem } from '../core/basket';
import { FEATURE_LABELS, hasFeature, upgradeMessage, type Plan, type ProFeature } from '../core/plan';
import { defaultSettings, type Settings } from '../core/settings';
import { saveSettings } from '../storage/store';
import { byId, h } from '../ui/dom';
import { svgIcon } from '../ui/icons';

/** State and small UI helpers shared by the popup's sections. */

export const els = {
  notice: byId<HTMLDivElement>('notice'),
  status: byId<HTMLDivElement>('status'),
};

export const state = {
  tabId: null as number | null,
  settings: defaultSettings() as Settings,
  plan: 'free' as Plan,
  basket: [] as BasketItem[],
};

// --- Settings -------------------------------------------------------------------------------

const settingsListeners = new Set<() => void>();

/** Called after every settings change (format switch, keep links, basket options). */
export function onSettingsChange(listener: () => void): void {
  settingsListeners.add(listener);
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  try {
    state.settings = await saveSettings(patch);
  } catch {
    showNotice('error', "Couldn't save the setting", 'Please try again.');
  }
  for (const listener of settingsListeners) listener();
}

// --- Notices --------------------------------------------------------------------------------

export type Tone = 'success' | 'error' | 'info' | 'warning';

/**
 * Alerts at the top of the popup. Each key holds one alert, so the page state ("can't read
 * this page"), a message left by the background and the latest error can coexist.
 */
export function showNotice(tone: Tone, title: string, detail?: string, key = 'message', dismissible = true, action?: HTMLElement): HTMLElement {
  const variant = { success: 'success', error: 'danger', info: 'primary', warning: 'warning' }[tone];
  const iconSource = { success: successIcon, error: errorIcon, info: infoIcon, warning: warningIcon }[tone];
  const alert = h(
    'div',
    {
      class: `alert alert-${variant} d-flex align-items-start gap-2 py-2 px-3 small mb-3`,
      attrs: { role: tone === 'error' ? 'alert' : 'status', 'data-key': key },
    },
    svgIcon(iconSource, 16),
    h('div', { class: 'min-w-0' }, h('div', { class: 'fw-bold', text: title }), detail ? h('div', { text: detail }) : null, action ?? null),
  );
  if (dismissible) {
    alert.append(h('button', { class: 'btn-close ms-auto', attrs: { type: 'button', 'aria-label': 'Dismiss' }, on: { click: () => dismissNotice(key) } }));
  }
  const existing = els.notice.querySelector(`[data-key="${key}"]`);
  if (existing) existing.replaceWith(alert);
  else els.notice.append(alert);
  els.notice.hidden = false;
  alert.scrollIntoView({ block: 'nearest' });
  return alert;
}

export function dismissNotice(key: string): void {
  els.notice.querySelector(`[data-key="${key}"]`)?.remove();
  if (!els.notice.childElementCount) els.notice.hidden = true;
}

export function announce(message: string): void {
  els.status.textContent = message;
}

// --- Pro ------------------------------------------------------------------------------------

export function isLocked(feature: ProFeature): boolean {
  return !hasFeature(state.plan, feature);
}

/** Pro features always go through hasFeature(); a free user gets one calm line and a link. */
export function allowed(feature: ProFeature): boolean {
  if (hasFeature(state.plan, feature)) return true;
  showNotice('info', FEATURE_LABELS[feature], upgradeMessage(feature), 'pro', true, aboutProLink('btn btn-link btn-sm p-0 mt-1'));
  return false;
}

export function aboutProLink(className = 'btn btn-link btn-sm p-0'): HTMLButtonElement {
  const link = h('button', { class: className, text: 'About Pro', attrs: { type: 'button' } });
  link.addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#pro') }));
  return link;
}

export function proBadge(): HTMLElement {
  return h('span', { class: 'badge pro-badge', text: 'PRO', attrs: { title: 'Pro feature' } });
}

/** A small lock on a control whose Pro feature this plan doesn't include. */
export function lockMark(): SVGSVGElement {
  const icon = svgIcon(lockIcon, 10);
  icon.classList.add('lock-mark');
  return icon;
}

// --- Buttons --------------------------------------------------------------------------------

export async function busy<T>(button: HTMLButtonElement, run: () => Promise<T>): Promise<T> {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await run();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

const flashed = new WeakMap<HTMLButtonElement, { children: Node[]; label: string | null; timer: number }>();

/** Inline success state on the button that was pressed, restored after a moment. */
export function flash(button: HTMLButtonElement, label: string, iconOnly = false): void {
  const current = flashed.get(button);
  const children = current?.children ?? Array.from(button.childNodes);
  const ariaLabel = current ? current.label : button.getAttribute('aria-label');
  window.clearTimeout(current?.timer);
  button.classList.add('is-done');
  if (iconOnly) {
    button.replaceChildren(svgIcon(checkIcon, 14));
    button.setAttribute('aria-label', label);
  } else {
    button.replaceChildren(svgIcon(checkIcon, 14), label);
  }
  const timer = window.setTimeout(() => {
    button.classList.remove('is-done');
    button.replaceChildren(...children);
    if (ariaLabel !== null) button.setAttribute('aria-label', ariaLabel);
    flashed.delete(button);
  }, 1600);
  flashed.set(button, { children, label: ariaLabel, timer });
}

export function emptyState(icon: string, message: string, extraClass = ''): HTMLElement {
  return h('div', { class: `empty-state ${extraClass}`.trim() }, svgIcon(icon, 22), h('span', { text: message }));
}

/** An icon-only button with a visible tooltip (hover and keyboard focus) and an accessible name. */
export function iconButton(action: string, icon: string, label: string, tip: string, locked = false): HTMLButtonElement {
  const button = h('button', { class: 'btn btn-tool', attrs: { type: 'button', 'data-action': action, 'aria-label': label, 'data-tip': tip } }, svgIcon(icon, 15));
  if (locked) button.append(lockMark());
  return button;
}

/** Cmd on macOS, Ctrl elsewhere. */
export function pasteShortcut(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return /mac/i.test(platform) ? '⌘V' : 'Ctrl+V';
}
