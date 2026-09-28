import checkIcon from 'bootstrap-icons/icons/check2.svg';
import clipboardIcon from 'bootstrap-icons/icons/clipboard-check.svg';
import cursorIcon from 'bootstrap-icons/icons/cursor-text.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import warningIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import gearIcon from 'bootstrap-icons/icons/gear.svg';
import globeIcon from 'bootstrap-icons/icons/globe2.svg';
import infoIcon from 'bootstrap-icons/icons/info-circle-fill.svg';
import keyboardIcon from 'bootstrap-icons/icons/keyboard.svg';
import successIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import { describeClean } from '../core/cleaner';
import { hasFeature, PRO_PRICE } from '../core/plan';
import type { Settings } from '../core/settings';
import { hostOf } from '../core/sites';
import type { PageCleanResult } from '../page/selection';
import type { CopyRequest } from '../platform/messages';
import { callPage } from '../platform/page';
import { loadState, saveSettings, takeNotice, type State } from '../storage/store';
import { copyFromPage } from '../ui/clipboard';
import { byId, h } from '../ui/dom';
import { formatCount, plural } from '../ui/format';
import { svgIcon } from '../ui/icons';
import { addSite, removeSite, siteStatuses } from '../ui/sites';

const COMMAND = 'copy-clean';
const PREVIEW_CHARS = 1200;

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  notice: byId<HTMLDivElement>('notice'),
  selectionSection: byId<HTMLElement>('selection-section'),
  selection: byId<HTMLDivElement>('selection'),
  selectionCount: byId<HTMLSpanElement>('selection-count'),
  auto: byId<HTMLDivElement>('auto'),
  shortcutIcon: byId<HTMLSpanElement>('shortcut-icon'),
  shortcutText: byId<HTMLSpanElement>('shortcut-text'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  status: byId<HTMLDivElement>('status'),
  quick: {
    merge: byId<HTMLInputElement>('quick-merge'),
    bullets: byId<HTMLInputElement>('quick-bullets'),
    tracking: byId<HTMLInputElement>('quick-tracking'),
    spaces: byId<HTMLInputElement>('quick-spaces'),
  },
};

let tab: chrome.tabs.Tab | undefined;
let state: State;
/** The page can be read (a regular web page with a scriptable top frame). */
let readable = true;

// --- Setup ------------------------------------------------------------------------------

async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  if (__E2E__) {
    // Tests open the popup as a normal page and point it at a fixture tab.
    const forced = Number(new URLSearchParams(location.search).get('tabId'));
    if (forced) return chrome.tabs.get(forced);
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active;
}

async function init(): Promise<void> {
  els.openOptions.append(svgIcon(gearIcon, 16));
  els.shortcutIcon.append(svgIcon(keyboardIcon, 14));
  addQuickChecks();
  renderLoading();

  const [notice, loaded, current] = await Promise.all([takeNotice(), loadState(), targetTab()]);
  state = loaded;
  tab = current;
  renderQuickOptions(state.settings);
  void renderShortcut();
  if (notice) showNotice(notice.tone, notice.title, notice.detail, 'stored');
  void clearBadge(tab?.id);
  await Promise.all([renderPreview(), renderAuto()]);
}

function renderLoading(): void {
  const line = (width: string) => h('span', { class: `placeholder d-block mb-1 rounded w-${width}` });
  els.selection.replaceChildren(
    h(
      'div',
      { class: 'card-body p-3 placeholder-glow', attrs: { 'aria-hidden': 'true' } },
      line('100'),
      line('75'),
      line('50'),
      h('span', { class: 'placeholder d-block w-100 rounded mt-3', attrs: { style: 'height: 2.25rem' } }),
    ),
  );
  els.auto.replaceChildren(h('div', { class: 'card-body p-3 placeholder-glow', attrs: { 'aria-hidden': 'true' } }, line('75')));
  els.status.textContent = 'Reading the selection…';
}

async function clearBadge(id: number | undefined): Promise<void> {
  try {
    await chrome.action.setBadgeText(id !== undefined ? { tabId: id, text: '' } : { text: '' });
  } catch {
    // Nothing to clear.
  }
}

async function renderShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((command) => command.name === COMMAND)?.shortcut;
    if (shortcut) els.shortcutText.replaceChildren(h('kbd', { text: shortcut }), ' copies the selection clean');
    else els.shortcutText.textContent = 'No keyboard shortcut set';
  } catch {
    els.shortcutText.textContent = 'Keyboard shortcut unavailable';
  }
}

// --- Notices ----------------------------------------------------------------------------

type Tone = 'success' | 'error' | 'info' | 'warning';

function showNotice(tone: Tone, title: string, detail?: string, key = 'message', dismissible = true): void {
  const variant = { success: 'success', error: 'danger', info: 'primary', warning: 'warning' }[tone];
  const iconSource = { success: successIcon, error: errorIcon, info: infoIcon, warning: warningIcon }[tone];
  const alert = h(
    'div',
    {
      class: `alert alert-${variant} d-flex align-items-start gap-2 py-2 px-3 small mb-3`,
      attrs: { role: tone === 'error' ? 'alert' : 'status', 'data-key': key },
    },
    svgIcon(iconSource, 16),
    h('div', {}, h('div', { class: 'fw-bold', text: title }), detail ? h('div', { text: detail }) : null),
  );
  if (dismissible) {
    alert.append(h('button', { class: 'btn-close ms-auto', attrs: { type: 'button', 'aria-label': 'Dismiss' }, on: { click: () => alert.remove() } }));
  }
  const existing = els.notice.querySelector(`[data-key="${key}"]`);
  if (existing) existing.replaceWith(alert);
  else els.notice.append(alert);
  els.notice.hidden = false;
}

function announce(message: string): void {
  els.status.textContent = message;
}

// --- Selection preview ------------------------------------------------------------------

function rulesFor(current: State) {
  return hasFeature(current.plan, 'custom-rules') ? current.rules : null;
}

async function readSelection(): Promise<PageCleanResult | null> {
  if (tab?.id === undefined) return null;
  try {
    return await callPage(tab.id, 0, 'clean', state.settings, rulesFor(state));
  } catch {
    return null;
  }
}

async function renderPreview(): Promise<void> {
  const result = await readSelection();
  els.selectionCount.textContent = '';
  if (!result) {
    readable = false;
    els.selection.replaceChildren(emptyState(warningIcon, "Chrome doesn't let extensions read this page."));
    if (!els.notice.querySelector('[data-key="stored"]')) {
      showNotice(
        'warning',
        "Clean Copy can't read this page",
        'chrome:// pages, the Chrome Web Store and the PDF viewer are off limits. The right-click "Copy clean" still cleans the text Chrome gives it.',
        'page',
        false,
      );
    }
    announce("This page can't be read.");
    return;
  }
  if (result.kind === 'empty' || !result.text.trim()) {
    els.selection.replaceChildren(
      emptyState(cursorIcon, result.kind === 'empty' ? 'Select text on the page, then open Clean Copy to see it cleaned.' : 'The selection has no visible text.'),
    );
    announce('Nothing is selected.');
    return;
  }
  els.selectionCount.textContent = `${formatCount(result.text.length)} ${plural(result.text.length, 'char')}`;
  const copyButton = h('button', { class: 'btn btn-primary w-100 copy-button', attrs: { type: 'button', id: 'copy-clean' } }, svgIcon(clipboardIcon, 16), 'Copy clean');
  copyButton.addEventListener('click', () => void copyClean(copyButton));
  const shown = result.text.length > PREVIEW_CHARS ? `${result.text.slice(0, PREVIEW_CHARS)}…` : result.text;
  els.selection.replaceChildren(
    h(
      'div',
      { class: 'card-body p-3' },
      h('pre', { class: 'clean-preview mb-2', text: shown, attrs: { id: 'preview', tabindex: '0', 'aria-label': 'Cleaned selection' } }),
      h('p', { class: 'clean-stats small text-body-secondary mb-3', text: describeClean(result.stats, result.text.length) }),
      result.truncated ? h('p', { class: 'small text-warning-emphasis mb-2', text: 'Very large selection: only the first part will be copied.' }) : null,
      copyButton,
    ),
  );
  announce('Selection cleaned. Ready to copy.');
}

async function copyClean(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  let copied = false;
  try {
    const result = await readSelection();
    if (!result || result.kind === 'empty' || !result.text.trim()) {
      showNotice('error', 'Nothing to copy', 'The selection is gone. Select text on the page and reopen the popup.');
      return;
    }
    copied = (await copyFromPage(result.text)) || (await copyInBackground(result.text));
    if (!copied) {
      showNotice('error', "Couldn't copy to the clipboard", 'Please try again.');
      return;
    }
    flashCopied(button);
    announce(`Copied clean text: ${formatCount(result.text.length)} ${plural(result.text.length, 'character')}.`);
  } finally {
    button.disabled = false;
  }
}

async function copyInBackground(text: string): Promise<boolean> {
  try {
    const request: CopyRequest = { type: 'cc/copy', text };
    const response = (await chrome.runtime.sendMessage(request)) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch {
    return false;
  }
}

function flashCopied(button: HTMLButtonElement): void {
  const children = Array.from(button.childNodes);
  button.classList.add('is-copied');
  button.replaceChildren(svgIcon(checkIcon, 16), 'Copied');
  window.setTimeout(() => {
    button.classList.remove('is-copied');
    button.replaceChildren(...children);
  }, 1600);
}

// --- Quick options ----------------------------------------------------------------------

function addQuickChecks(): void {
  for (const input of Object.values(els.quick)) document.querySelector(`label[for="${input.id}"]`)?.prepend(svgIcon(checkIcon, 12));
}

function renderQuickOptions(settings: Settings): void {
  els.quick.merge.checked = settings.lineBreaks === 'merge';
  els.quick.bullets.checked = settings.keepBullets;
  els.quick.tracking.checked = settings.stripTracking;
  els.quick.spaces.checked = settings.collapseWhitespace;
}

async function updateOption(patch: Partial<Settings>): Promise<void> {
  try {
    state.settings = await saveSettings(patch);
  } catch {
    showNotice('error', "Couldn't save the setting", 'Please try again.');
  }
  renderQuickOptions(state.settings);
  if (readable) await renderPreview();
}

// --- Auto-clean -------------------------------------------------------------------------

async function renderAuto(): Promise<void> {
  const host = hostOf(tab?.url);
  const statuses = await siteStatuses(state.sites);
  const others = statuses.filter((site) => site.host !== host);
  const manage = h('button', { class: 'btn btn-link btn-sm p-0', text: 'Manage sites', attrs: { type: 'button' }, on: { click: () => void chrome.runtime.openOptionsPage() } });
  const footer = h(
    'div',
    { class: 'd-flex align-items-center gap-2 small text-body-secondary mt-2' },
    h('span', { text: others.length ? `Also on ${others.length} other ${plural(others.length, 'site')}.` : 'Only on the sites you pick.' }),
    h('span', { class: 'ms-auto text-nowrap' }, manage),
  );

  if (!hasFeature(state.plan, 'auto-clean')) {
    els.auto.replaceChildren(
      h('div', { class: 'card-body p-3 small' }, h('p', { class: 'mb-1', text: `Auto-clean is part of Clean Copy Pro (${PRO_PRICE}, one time).` }), footer),
    );
    return;
  }
  if (!host) {
    els.auto.replaceChildren(h('div', { class: 'card-body p-3' }, emptyState(globeIcon, 'Auto-clean works on regular web pages (http and https).', 'p-0'), footer));
    return;
  }

  const current = statuses.find((site) => site.host === host);
  const input = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', role: 'switch', id: 'auto-here' } });
  input.checked = Boolean(current);
  const label = h('label', { class: 'form-check-label', attrs: { for: 'auto-here' } }, 'Clean every copy on ', h('span', { class: 'fw-bold text-break', text: host }));
  const hint = h('div', { class: 'small mt-1', attrs: { id: 'auto-state' } });
  if (!current) hint.replaceChildren(h('span', { class: 'text-body-secondary', text: 'Off. Turning it on asks for access to this site only.' }));
  else if (current.active) hint.replaceChildren(h('span', { class: 'text-success-emphasis fw-semibold', text: 'On: Ctrl+C here copies clean text.' }));
  else {
    hint.replaceChildren(
      h('span', { class: 'text-warning-emphasis', text: 'Needs access to this site. ' }),
      h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', text: 'Allow', attrs: { type: 'button', id: 'auto-grant' }, on: { click: () => void toggleHere(host, true) } }),
    );
  }
  input.addEventListener('change', () => void toggleHere(host, input.checked));
  els.auto.replaceChildren(h('div', { class: 'card-body p-3' }, h('div', { class: 'form-check form-switch mb-0' }, input, label), hint, footer));
}

async function toggleHere(host: string, on: boolean): Promise<void> {
  if (on) {
    // The permission prompt must come straight from the click: no awaits before it.
    const granted = await addSite(host, state.sites);
    state = await loadState();
    if (!granted) showNotice('warning', 'Auto-clean not turned on', `Chrome didn't give Clean Copy access to ${host}.`);
    else announce(`Auto-clean is on for ${host}.`);
  } else {
    state.sites = await removeSite(host, state.sites);
    announce(`Auto-clean is off for ${host}.`);
  }
  await renderAuto();
}

// --- Helpers ----------------------------------------------------------------------------

function emptyState(icon: string, message: string, extraClass = ''): HTMLElement {
  return h('div', { class: `empty-state ${extraClass}`.trim() }, svgIcon(icon, 22), h('span', { text: message }));
}

// --- Events -----------------------------------------------------------------------------

els.openOptions.addEventListener('click', () => void chrome.runtime.openOptionsPage());
els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
els.quick.merge.addEventListener('change', () => void updateOption({ lineBreaks: els.quick.merge.checked ? 'merge' : 'keep' }));
els.quick.bullets.addEventListener('change', () => void updateOption({ keepBullets: els.quick.bullets.checked }));
els.quick.tracking.addEventListener('change', () => void updateOption({ stripTracking: els.quick.tracking.checked }));
els.quick.spaces.addEventListener('change', () => void updateOption({ collapseWhitespace: els.quick.spaces.checked }));

init().catch((error: unknown) => {
  console.error('Clean Copy: popup failed', error);
  showNotice('error', 'Clean Copy failed to start', 'Close and reopen the popup.');
});
