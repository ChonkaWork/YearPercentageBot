import checkIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import infoIcon from 'bootstrap-icons/icons/info-circle-fill.svg';
import undoIcon from 'bootstrap-icons/icons/arrow-counterclockwise.svg';
import closeIcon from 'bootstrap-icons/icons/x-lg.svg';
import type { UndoRequest, UndoResponse } from '../platform/messages';
import css from '../styles/inpage.scss';
import { svgIcon } from '../ui/icons';

/**
 * A small confirmation in the corner of the page after a copy, with an Undo action that puts
 * the original (what a normal copy would have given) back on the clipboard. Lives in a closed
 * shadow root (open in the e2e build) so the page's CSS can't touch it and it can't touch
 * the page. Page content only ever reaches it as text.
 */

export interface ToastMessage {
  tone: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
  /** Smaller and shorter: the confirmation after an automatic clean on Ctrl+C. */
  compact?: boolean;
  /** Id of the kept copy: shows "Undo". */
  undo?: string;
}

export const TOAST_TAG = 'clean-copy-toast';
const DURATION_MS = { success: 2600, info: 4000, error: 6000 } as const;
const COMPACT_MS = 1400;
/** Long enough to reach for Undo. */
const UNDO_MS = 5000;

const UNDO_ERRORS: Record<NonNullable<UndoResponse['reason']>, string> = {
  stale: 'A newer copy replaced it.',
  missing: 'It is no longer kept (the browser was restarted).',
  'too-large': 'The original was too large to keep.',
  clipboard: 'The clipboard refused. Please try again.',
};

let timer: number | undefined;

export function showToast(message: ToastMessage): void {
  // A copy injected before an extension update may have left its host behind.
  for (const stale of Array.from(document.querySelectorAll(TOAST_TAG))) stale.remove();
  window.clearTimeout(timer);

  const host = document.createElement(TOAST_TAG);
  host.style.cssText =
    'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;';
  const root = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
  }

  const toast = document.createElement('div');
  toast.setAttribute('aria-atomic', 'true');
  const iconSlot = document.createElement('span');
  iconSlot.className = 'cc-icon';
  const text = document.createElement('div');
  text.className = 'cc-text';
  const title = document.createElement('div');
  title.className = 'cc-title';
  const detail = document.createElement('div');
  detail.className = 'cc-detail';
  text.append(title, detail);

  const render = (tone: ToastMessage['tone'], titleText: string, detailText?: string) => {
    toast.className = `toast show cc-toast cc-${tone}${message.compact ? ' cc-compact' : ''}`;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    iconSlot.replaceChildren(svgIcon(tone === 'success' ? checkIcon : tone === 'error' ? errorIcon : infoIcon, 18));
    title.textContent = titleText;
    detail.textContent = detailText ?? '';
    detail.hidden = !detailText;
  };
  render(message.tone, message.title, message.detail);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'cc-close';
  close.setAttribute('aria-label', 'Close');
  close.append(svgIcon(closeIcon, 12));
  close.addEventListener('click', () => host.remove());

  const body = document.createElement('div');
  body.className = 'toast-body cc-body';
  body.append(iconSlot, text);

  let hovered = false;
  let duration = message.compact && message.tone === 'success' ? COMPACT_MS : DURATION_MS[message.tone];
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!hovered && !toast.contains(root.activeElement)) host.remove();
    }, duration);
  };

  if (message.undo) {
    const id = message.undo;
    duration = Math.max(duration, UNDO_MS);
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'cc-action';
    undo.append(svgIcon(undoIcon, 14), 'Undo');
    undo.title = 'Put the original (with its formatting) back on the clipboard';
    undo.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      undo.disabled = true;
      void requestUndo(id).then((response) => {
        undo.remove();
        if (response.ok) {
          render('success', 'Original restored', response.withHtml ? 'The copy as the page gave it, formatting included.' : 'The original text is back on the clipboard.');
        } else {
          render('error', "Couldn't restore the original", UNDO_ERRORS[response.reason ?? 'clipboard']);
        }
        duration = DURATION_MS.success;
        schedule();
      });
    });
    body.append(undo);
  }
  body.append(close);
  toast.append(body);
  root.append(toast);
  document.documentElement.append(host);

  toast.addEventListener('mouseenter', () => (hovered = true));
  toast.addEventListener('mouseleave', () => {
    hovered = false;
    schedule();
  });
  toast.addEventListener('focusout', () => schedule());
  schedule();
}

async function requestUndo(id: string): Promise<UndoResponse> {
  try {
    const request: UndoRequest = { type: 'cc/undo', id };
    const response = (await chrome.runtime.sendMessage(request)) as UndoResponse | undefined;
    return response ?? { ok: false, reason: 'clipboard' };
  } catch {
    // The extension was updated or removed since this page loaded.
    return { ok: false, reason: 'missing' };
  }
}
