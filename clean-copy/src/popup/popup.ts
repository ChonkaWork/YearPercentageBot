import undoIcon from 'bootstrap-icons/icons/arrow-counterclockwise.svg';
import checkIcon from 'bootstrap-icons/icons/check2.svg';
import historyIcon from 'bootstrap-icons/icons/clock-history.svg';
import clipboardIcon from 'bootstrap-icons/icons/clipboard-check.svg';
import cleanClipboardIcon from 'bootstrap-icons/icons/eraser.svg';
import cursorIcon from 'bootstrap-icons/icons/cursor-text.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import warningIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import gearIcon from 'bootstrap-icons/icons/gear.svg';
import globeIcon from 'bootstrap-icons/icons/globe2.svg';
import infoIcon from 'bootstrap-icons/icons/info-circle-fill.svg';
import keyboardIcon from 'bootstrap-icons/icons/keyboard.svg';
import shieldIcon from 'bootstrap-icons/icons/shield-check.svg';
import successIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import { hasChanges, type Segment } from '../core/changes';
import { describeClean } from '../core/cleaner';
import { prepareLastCopy, timeAgo, viaLabel, type LastCopy } from '../core/lastCopy';
import { hasFeature, PRO_PRICE } from '../core/plan';
import type { Settings } from '../core/settings';
import { ALL_SITES_PATTERN, hostOf } from '../core/sites';
import type { PageCleanResult } from '../page/selection';
import type { CleanClipboardRequest, ClipboardOutcome, CopyRequest, UndoRequest, UndoResponse } from '../platform/messages';
import { callPage } from '../platform/page';
import { clearLastCopy, loadLastCopy, loadState, saveLastCopy, saveSettings, setPendingClipboardClean, takeNotice, type State } from '../storage/store';
import { renderChanges, renderLegend } from '../ui/changes';
import { copyFromPage } from '../ui/clipboard';
import { byId, h } from '../ui/dom';
import { formatCount, plural } from '../ui/format';
import { svgIcon } from '../ui/icons';
import { addSite, removeSite, siteStatuses } from '../ui/sites';

const COMMAND = 'copy-clean';
const PREVIEW_CHARS = 1200;
const LAST_CHARS = 20_000;
const SHOW_CHANGES_KEY = 'cc-show-changes';
const CLIPBOARD_PERMISSION: chrome.permissions.Permissions = { permissions: ['clipboardRead'] };

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  autoPill: byId<HTMLSpanElement>('auto-pill'),
  notice: byId<HTMLDivElement>('notice'),
  tabs: { selection: byId<HTMLButtonElement>('tab-selection'), last: byId<HTMLButtonElement>('tab-last') },
  panels: { selection: byId<HTMLDivElement>('panel-selection'), last: byId<HTMLDivElement>('panel-last') },
  showChanges: byId<HTMLInputElement>('show-changes'),
  selection: byId<HTMLDivElement>('selection'),
  last: byId<HTMLDivElement>('last'),
  auto: byId<HTMLDivElement>('auto'),
  shortcutIcon: byId<HTMLSpanElement>('shortcut-icon'),
  shortcutText: byId<HTMLSpanElement>('shortcut-text'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  status: byId<HTMLDivElement>('status'),
  quickGroup: byId<HTMLDivElement>('quick-options'),
  quick: {
    merge: byId<HTMLInputElement>('quick-merge'),
    bullets: byId<HTMLInputElement>('quick-bullets'),
    tracking: byId<HTMLInputElement>('quick-tracking'),
    spaces: byId<HTMLInputElement>('quick-spaces'),
  },
};

type View = keyof typeof els.tabs;

let tab: chrome.tabs.Tab | undefined;
let state: State;
let lastCopy: LastCopy | null = null;
/** The page can be read (a regular web page with a scriptable top frame). */
let readable = true;
/** The last preview, re-rendered when "Show changes" is switched. */
let preview: PageCleanResult | null = null;
/** e2e only: pretend clipboard access hasn't been granted yet, to exercise the explanation. */
let forceAskClipboard = false;

// --- Setup ------------------------------------------------------------------------------

async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  if (__E2E__) {
    // Tests open the popup as a normal page and point it at a fixture tab.
    const params = new URLSearchParams(location.search);
    forceAskClipboard = params.has('askClipboard');
    const forced = Number(params.get('tabId'));
    if (forced) return chrome.tabs.get(forced);
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active;
}

async function init(): Promise<void> {
  els.openOptions.append(svgIcon(gearIcon, 16));
  els.shortcutIcon.append(svgIcon(keyboardIcon, 14));
  els.showChanges.checked = readShowChanges();
  renderLoading();

  const [notice, loaded, current, last] = await Promise.all([takeNotice(), loadState(), targetTab(), loadLastCopy()]);
  state = loaded;
  tab = current;
  lastCopy = last;
  renderQuickOptions(state.settings);
  void renderShortcut();
  if (notice) showNotice(notice.tone, notice.title, notice.detail, 'stored');
  void clearNoticeBadge(tab?.id);
  renderLast();
  await Promise.all([renderPreview(), renderAuto()]);
  // Nothing to preview, but a copy was just made: show that instead.
  if ((!preview || !preview.text.trim()) && lastCopy) selectView('last', false);
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

/** Clears the ✓/! badge of a notice; the auto-clean "ON" badge stays. */
async function clearNoticeBadge(id: number | undefined): Promise<void> {
  if (id === undefined) return;
  try {
    if ((await chrome.action.getBadgeText({ tabId: id })) !== 'ON') await chrome.action.setBadgeText({ tabId: id, text: '' });
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

function readShowChanges(): boolean {
  try {
    return localStorage.getItem(SHOW_CHANGES_KEY) !== 'off';
  } catch {
    return true;
  }
}

// --- Notices ----------------------------------------------------------------------------

type Tone = 'success' | 'error' | 'info' | 'warning';

function showNotice(tone: Tone, title: string, detail?: string, key = 'message', dismissible = true, actions: HTMLElement[] = []): HTMLElement {
  const variant = { success: 'success', error: 'danger', info: 'primary', warning: 'warning' }[tone];
  const iconSource = { success: successIcon, error: errorIcon, info: infoIcon, warning: warningIcon }[tone];
  const alert = h(
    'div',
    {
      class: `alert alert-${variant} d-flex align-items-start gap-2 py-2 px-3 small mb-3`,
      attrs: { role: tone === 'error' ? 'alert' : 'status', 'data-key': key },
    },
    svgIcon(iconSource, 16),
    h(
      'div',
      { class: 'flex-grow-1' },
      h('div', { class: 'fw-bold', text: title }),
      detail ? h('div', { text: detail }) : null,
      actions.length ? h('div', { class: 'd-flex gap-2 mt-2' }, ...actions) : null,
    ),
  );
  if (dismissible) {
    alert.append(h('button', { class: 'btn-close ms-auto', attrs: { type: 'button', 'aria-label': 'Dismiss' }, on: { click: () => alert.remove() } }));
  }
  const existing = els.notice.querySelector(`[data-key="${key}"]`);
  if (existing) existing.replaceWith(alert);
  else els.notice.append(alert);
  els.notice.hidden = false;
  return alert;
}

function dismissNotice(key: string): void {
  els.notice.querySelector(`[data-key="${key}"]`)?.remove();
}

function announce(message: string): void {
  els.status.textContent = message;
}

// --- Views (Selection | Last copy) --------------------------------------------------------

function selectView(view: View, focus: boolean): void {
  for (const name of Object.keys(els.tabs) as View[]) {
    const selected = name === view;
    els.tabs[name].setAttribute('aria-selected', String(selected));
    els.tabs[name].tabIndex = selected ? 0 : -1;
    els.panels[name].hidden = !selected;
  }
  // The quick options change what the selection becomes; the last copy is already made.
  els.quickGroup.hidden = view !== 'selection';
  if (focus) els.tabs[view].focus();
}

function onTabKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  const current: View = els.tabs.last.getAttribute('aria-selected') === 'true' ? 'last' : 'selection';
  const next: View = event.key === 'Home' ? 'selection' : event.key === 'End' ? 'last' : current === 'selection' ? 'last' : 'selection';
  selectView(next, true);
}

/** The annotated text, or just the clean text when "Show changes" is off. */
function textView(target: HTMLElement, changes: Segment[] | undefined, clean: string, maxChars: number): void {
  if (els.showChanges.checked && changes) {
    renderChanges(target, changes, maxChars);
  } else {
    target.textContent = clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
  }
}

// --- Selection preview ------------------------------------------------------------------

function rulesFor(current: State) {
  return hasFeature(current.plan, 'custom-rules') ? current.rules : null;
}

async function readSelection(withOriginal: boolean): Promise<PageCleanResult | null> {
  if (tab?.id === undefined) return null;
  try {
    return await callPage(tab.id, 0, 'clean', state.settings, rulesFor(state), withOriginal);
  } catch {
    return null;
  }
}

async function renderPreview(): Promise<void> {
  const result = await readSelection(false);
  preview = result;
  if (!result) {
    readable = false;
    els.selection.replaceChildren(h('div', { class: 'card-body p-3' }, emptyState(warningIcon, "Chrome doesn't let extensions read this page.", 'p-0 mb-3'), actionRow(null)));
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
      h(
        'div',
        { class: 'card-body p-3' },
        emptyState(cursorIcon, result.kind === 'empty' ? 'Select text on the page to see it cleaned here.' : 'The selection has no visible text.', 'p-0 mb-3'),
        actionRow(null),
      ),
    );
    announce('Nothing is selected.');
    return;
  }
  const copyButton = h('button', { class: 'btn btn-primary copy-button', attrs: { type: 'button', id: 'copy-clean' } }, svgIcon(clipboardIcon, 16), 'Copy clean');
  copyButton.addEventListener('click', () => void copyClean(copyButton));
  const text = h('pre', { class: 'clean-preview mb-2', attrs: { id: 'preview', tabindex: '0', 'aria-label': 'Cleaned selection, with what was removed' } });
  textView(text, result.changes, result.text, PREVIEW_CHARS);
  els.selection.replaceChildren(
    h(
      'div',
      { class: 'card-body p-3' },
      text,
      h('p', { class: 'clean-stats small text-body-secondary mb-3', text: describeClean(result.stats, result.text.length) }),
      result.truncated ? h('p', { class: 'small text-warning-emphasis mb-2', text: 'Very large selection: only the first part will be copied.' }) : null,
      actionRow(copyButton),
    ),
  );
  announce(result.changes && hasChanges(result.changes) ? 'Selection cleaned; removals are highlighted. Ready to copy.' : 'Selection cleaned. Ready to copy.');
}

/** Copy clean (when there is a selection) and Clean clipboard (always). */
function actionRow(copyButton: HTMLButtonElement | null): HTMLElement {
  const clean = h(
    'button',
    { class: `btn ${copyButton ? 'btn-outline-secondary' : 'btn-outline-primary w-100'} clean-clipboard`, attrs: { type: 'button', id: 'clean-clipboard', title: 'Clean the text that is already on the clipboard' } },
    svgIcon(cleanClipboardIcon, 16),
    'Clean clipboard',
  );
  clean.addEventListener('click', () => void onCleanClipboard(clean));
  return h('div', { class: copyButton ? 'action-row' : '' }, copyButton, clean);
}

async function copyClean(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  let copied = false;
  try {
    const result = await readSelection(true);
    if (!result || result.kind === 'empty' || !result.text.trim()) {
      showNotice('error', 'Nothing to copy', 'The selection is gone. Select text on the page and reopen the popup.');
      return;
    }
    copied = (await copyFromPage(result.text)) || (await copyInBackground(result.text));
    if (!copied) {
      showNotice('error', "Couldn't copy to the clipboard", 'Please try again.');
      return;
    }
    lastCopy = prepareLastCopy({
      via: 'popup',
      host: hostOf(tab?.url),
      original: result.original ?? null,
      cleaned: result.text,
      summary: describeClean(result.stats, result.text.length),
      changes: result.changes,
    });
    await saveLastCopy(lastCopy);
    renderLast();
    flashCopied(button);
    announce(`Copied clean text: ${formatCount(result.text.length)} ${plural(result.text.length, 'character')}. Last copy can restore the original.`);
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
  flash(button, 'Copied');
}

/** A short confirmation inside the button itself, then back to its label. */
function flash(button: HTMLButtonElement, label: string): void {
  const children = Array.from(button.childNodes);
  button.classList.add('is-copied');
  button.replaceChildren(svgIcon(checkIcon, 16), label);
  window.setTimeout(() => {
    button.classList.remove('is-copied');
    button.replaceChildren(...children);
  }, 1600);
}

// --- Clean clipboard --------------------------------------------------------------------

async function hasClipboardAccess(): Promise<boolean> {
  if (forceAskClipboard) return false;
  try {
    return await chrome.permissions.contains(CLIPBOARD_PERMISSION);
  } catch {
    return false;
  }
}

async function onCleanClipboard(button: HTMLButtonElement): Promise<void> {
  if (!(await hasClipboardAccess())) {
    explainClipboard();
    return;
  }
  button.disabled = true;
  try {
    await runClipboardClean({ type: 'cc/clean-clipboard' });
  } finally {
    button.disabled = false;
  }
}

/** First use: before Chrome asks, say what reading the clipboard means (in place of the preview). */
function explainClipboard(): void {
  selectView('selection', false);
  const allow = h('button', { class: 'btn btn-primary btn-sm', text: 'Allow and clean', attrs: { type: 'button', id: 'allow-clipboard' } });
  const later = h('button', { class: 'btn btn-outline-secondary btn-sm', text: 'Not now', attrs: { type: 'button', id: 'not-now' } });
  allow.addEventListener('click', () => void allowClipboard(allow));
  later.addEventListener('click', () => {
    void renderPreview().then(() => document.getElementById('clean-clipboard')?.focus());
  });
  els.selection.replaceChildren(
    h(
      'div',
      { class: 'card-body p-3 clipboard-ask', attrs: { id: 'clipboard-ask', role: 'group', 'aria-labelledby': 'clipboard-ask-title' } },
      h(
        'div',
        { class: 'd-flex align-items-start gap-2' },
        svgIcon(shieldIcon, 20),
        h(
          'div',
          {},
          h('div', { class: 'fw-bold mb-1', text: 'Let Clean Copy read the clipboard?', attrs: { id: 'clipboard-ask-title' } }),
          h('p', {
            class: 'small text-body-secondary mb-0',
            text: 'To clean what is already on your clipboard, Clean Copy reads its text, cleans it and writes it back. It reads only when you click Clean clipboard or use its shortcut, and nothing leaves your computer. Chrome asks you to confirm once.',
          }),
        ),
      ),
      h('div', { class: 'd-flex gap-2 mt-3' }, allow, later),
    ),
  );
  allow.focus();
  announce('Clean clipboard needs your permission to read the clipboard.');
}

async function allowClipboard(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  // No awaits before the prompt: it must come straight from the click. The flag lets the
  // background finish the job if this popup closes while Chrome's prompt is open.
  const pending = setPendingClipboardClean().catch(() => undefined);
  let granted = false;
  try {
    granted = await chrome.permissions.request(CLIPBOARD_PERMISSION);
  } catch {
    granted = await chrome.permissions.contains(CLIPBOARD_PERMISSION).catch(() => false);
  }
  await pending;
  if (!granted) {
    await renderPreview();
    showNotice('warning', 'Clipboard not cleaned', "Chrome didn't give Clean Copy access to the clipboard. Copy clean works without it.", 'clipboard-result');
    return;
  }
  forceAskClipboard = false;
  await runClipboardClean({ type: 'cc/clean-clipboard', afterGrant: true });
}

async function runClipboardClean(request: CleanClipboardRequest): Promise<void> {
  let outcome: ClipboardOutcome;
  try {
    outcome = ((await chrome.runtime.sendMessage(request)) as ClipboardOutcome | undefined) ?? { status: 'error', message: 'Please try again.' };
  } catch {
    outcome = { status: 'error', message: 'Please try again.' };
  }
  if (outcome.status === 'needs-permission') {
    explainClipboard();
    return;
  }
  // Back from the explanation (if it was showing) to the preview.
  if (document.getElementById('clipboard-ask')) await renderPreview();
  const button = document.getElementById('clean-clipboard') as HTMLButtonElement | null;
  switch (outcome.status) {
    case 'cleaned':
      lastCopy = await loadLastCopy();
      renderLast();
      selectView('last', false);
      dismissNotice('clipboard-result');
      els.last.querySelector<HTMLElement>('#changes')?.focus();
      announce(`Clipboard cleaned: ${outcome.summary}. Last copy shows what was removed; Restore original undoes it.`);
      break;
    case 'unchanged':
      if (button) flash(button, 'Already clean');
      announce('The clipboard is already clean: its text has nothing to remove.');
      break;
    case 'empty':
      if (button) flash(button, 'Clipboard is empty');
      announce('Nothing to clean: the clipboard has no text.');
      break;
    default:
      showNotice('error', "Couldn't clean the clipboard", outcome.message, 'clipboard-result');
  }
}

// --- Last copy ----------------------------------------------------------------------------

function renderLast(): void {
  const copy = lastCopy;
  if (!copy) {
    els.last.replaceChildren(
      h(
        'div',
        { class: 'card-body p-3' },
        emptyState(historyIcon, 'Nothing copied yet. Your next clean copy shows up here, with what was removed and a way to put the original back.', 'p-0'),
      ),
    );
    return;
  }
  const meta = h('div', { class: 'last-meta small text-body-secondary mb-2' }, h('span', { text: viaLabel(copy.via) }), h('span', { text: timeAgo(copy.at, Date.now()) }));
  if (copy.host) meta.append(h('span', { class: 'text-truncate', text: copy.host }));

  const body = h('div', { class: 'card-body p-3' }, meta);
  if (copy.cleaned || copy.changes) {
    const view = h('pre', { class: 'clean-preview changes-view mb-2', attrs: { id: 'changes', tabindex: '0', 'aria-label': 'Last copy, with what was removed' } });
    textView(view, copy.changes, copy.cleaned, LAST_CHARS);
    body.append(view);
    if (els.showChanges.checked && copy.changes) {
      const legend = h('div', { class: 'chg-legend mb-2', attrs: { 'aria-label': 'Kinds of change' } });
      renderLegend(legend, copy.changes);
      body.append(legend);
    }
    if (els.showChanges.checked && !copy.changes) body.append(h('p', { class: 'small text-body-secondary mb-2', text: 'Changes are not shown for very large copies.' }));
  } else {
    body.append(h('p', { class: 'small text-body-secondary mb-2', text: `A very large copy (${formatCount(copy.length)} characters): its text isn't shown here.` }));
  }
  body.append(h('p', { class: 'clean-stats small text-body-secondary mb-3', text: copy.summary }));

  const actions = h('div', { class: 'd-flex align-items-center gap-2' });
  if (copy.restoredAt) {
    actions.append(h('span', { class: 'restored small fw-semibold text-success-emphasis d-inline-flex align-items-center gap-1', attrs: { id: 'restored' } }, svgIcon(successIcon, 14), 'Original restored'));
    if (copy.cleaned) {
      const again = h('button', { class: 'btn btn-outline-primary btn-sm ms-auto', text: 'Copy clean again', attrs: { type: 'button', id: 'copy-again' } });
      again.addEventListener('click', () => void copyAgain(copy));
      actions.append(again);
    }
  } else {
    const restore = h(
      'button',
      { class: 'btn btn-outline-primary btn-sm d-inline-flex align-items-center gap-1', attrs: { type: 'button', id: 'restore-original' } },
      svgIcon(undoIcon, 14),
      'Restore original',
    );
    restore.disabled = !copy.original;
    if (!copy.original) restore.title = 'The original was too large to keep';
    restore.addEventListener('click', () => void restoreOriginal(copy, restore));
    actions.append(restore);
  }
  const forget = h('button', { class: 'btn btn-link btn-sm text-body-secondary ms-auto', text: 'Forget', attrs: { type: 'button', id: 'forget-copy', title: 'Remove the kept original and changes from memory now' } });
  forget.addEventListener('click', () => void forgetCopy());
  if (copy.restoredAt && copy.cleaned) forget.classList.remove('ms-auto');
  actions.append(forget);
  body.append(actions);
  if (!copy.original) body.append(h('p', { class: 'small text-body-secondary mt-2 mb-0', text: 'The original was too large to keep, so it cannot be restored.' }));
  els.last.replaceChildren(body);
}

async function restoreOriginal(copy: LastCopy, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  let response: UndoResponse;
  try {
    const request: UndoRequest = { type: 'cc/undo', id: copy.id };
    response = ((await chrome.runtime.sendMessage(request)) as UndoResponse | undefined) ?? { ok: false, reason: 'clipboard' };
  } catch {
    response = { ok: false, reason: 'clipboard' };
  }
  if (!response.ok) {
    button.disabled = false;
    showNotice('error', "Couldn't restore the original", response.reason === 'clipboard' ? 'The clipboard refused. Please try again.' : 'It is no longer kept.', 'restore');
    return;
  }
  lastCopy = (await loadLastCopy()) ?? { ...copy, restoredAt: Date.now() };
  renderLast();
  els.last.querySelector<HTMLButtonElement>('#copy-again')?.focus();
  announce(response.withHtml ? 'Original restored, formatting included.' : 'Original text restored.');
}

async function copyAgain(copy: LastCopy): Promise<void> {
  const copied = (await copyFromPage(copy.cleaned)) || (await copyInBackground(copy.cleaned));
  if (!copied) {
    showNotice('error', "Couldn't copy to the clipboard", 'Please try again.', 'restore');
    return;
  }
  const { restoredAt: _restored, ...rest } = copy;
  lastCopy = rest;
  await saveLastCopy(rest);
  renderLast();
  els.last.querySelector<HTMLButtonElement>('#restore-original')?.focus();
  announce('Clean text copied again.');
}

async function forgetCopy(): Promise<void> {
  await clearLastCopy();
  lastCopy = null;
  renderLast();
  els.tabs.last.focus();
  announce('The last copy was forgotten.');
}

// --- Quick options ----------------------------------------------------------------------

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
  let everywhere = false;
  if (state.allSites) {
    everywhere = await chrome.permissions.contains({ origins: [ALL_SITES_PATTERN] }).catch(() => false);
  }
  const others = statuses.filter((site) => site.host !== host);
  const manage = h('button', { class: 'btn btn-link btn-sm p-0', text: everywhere ? 'Settings' : 'Manage sites', attrs: { type: 'button' }, on: { click: () => void chrome.runtime.openOptionsPage() } });
  const footer = h(
    'div',
    { class: 'd-flex align-items-center gap-2 small text-body-secondary mt-2' },
    h('span', { text: everywhere ? 'All sites is on.' : others.length ? `Also on ${others.length} other ${plural(others.length, 'site')}.` : 'Only on the sites you pick.' }),
    h('span', { class: 'ms-auto text-nowrap' }, manage),
  );
  setAutoPill(false);

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
  if (everywhere) {
    setAutoPill(true);
    els.auto.replaceChildren(
      h('div', { class: 'card-body p-3' }, onHere(`Every Ctrl+C on ${host} comes out clean.`), footer),
    );
    return;
  }

  const current = statuses.find((site) => site.host === host);
  const input = h('input', { class: 'form-check-input', attrs: { type: 'checkbox', role: 'switch', id: 'auto-here' } });
  input.checked = Boolean(current);
  const label = h('label', { class: 'form-check-label', attrs: { for: 'auto-here' } }, 'Clean every copy on ', h('span', { class: 'fw-bold text-break', text: host }));
  const hint = h('div', { class: 'small mt-1', attrs: { id: 'auto-state' } });
  let bottom: HTMLElement | null = footer;
  if (!current) {
    hint.classList.add('d-flex', 'align-items-baseline', 'gap-2');
    hint.replaceChildren(h('span', { class: 'text-body-secondary', text: 'Off. Asks for access to this site only.' }));
    // Nothing else to say: the link shares the line.
    if (!others.length) {
      hint.append(h('span', { class: 'ms-auto text-nowrap' }, manage));
      bottom = null;
    }
  } else if (current.active) {
    setAutoPill(true);
    hint.replaceChildren(onHere('Ctrl+C here copies clean text.'));
  } else {
    hint.replaceChildren(
      h('span', { class: 'text-warning-emphasis', text: 'Needs access to this site. ' }),
      h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', text: 'Allow', attrs: { type: 'button', id: 'auto-grant' }, on: { click: () => void toggleHere(host, true) } }),
    );
  }
  input.addEventListener('change', () => void toggleHere(host, input.checked));
  els.auto.replaceChildren(h('div', { class: 'card-body p-3' }, h('div', { class: 'form-check form-switch mb-0' }, input, label), hint, bottom));
}

/** "Auto-clean is on here", impossible to miss. */
function onHere(detail: string): HTMLElement {
  return h(
    'div',
    { class: 'auto-on', attrs: { id: 'auto-on' } },
    svgIcon(shieldIcon, 16),
    h('div', {}, h('div', { class: 'fw-bold', text: 'Auto-clean is on here' }), h('div', { class: 'small', text: detail })),
  );
}

function setAutoPill(on: boolean): void {
  els.autoPill.hidden = !on;
  els.autoPill.replaceChildren(...(on ? [svgIcon(shieldIcon, 12), 'Auto-clean on'] : []));
  if (on) els.autoPill.title = 'Ctrl+C on this site copies clean text';
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
els.tabs.selection.addEventListener('click', () => selectView('selection', false));
els.tabs.last.addEventListener('click', () => selectView('last', false));
els.tabs.selection.addEventListener('keydown', onTabKey);
els.tabs.last.addEventListener('keydown', onTabKey);
els.showChanges.addEventListener('change', () => {
  try {
    localStorage.setItem(SHOW_CHANGES_KEY, els.showChanges.checked ? 'on' : 'off');
  } catch {
    // Per-viewer convenience only.
  }
  const view = document.getElementById('preview');
  if (view && preview) textView(view, preview.changes, preview.text, PREVIEW_CHARS);
  renderLast();
});
els.quick.merge.addEventListener('change', () => void updateOption({ lineBreaks: els.quick.merge.checked ? 'merge' : 'keep' }));
els.quick.bullets.addEventListener('change', () => void updateOption({ keepBullets: els.quick.bullets.checked }));
els.quick.tracking.addEventListener('change', () => void updateOption({ stripTracking: els.quick.tracking.checked }));
els.quick.spaces.addEventListener('change', () => void updateOption({ collapseWhitespace: els.quick.spaces.checked }));

init().catch((error: unknown) => {
  console.error('Clean Copy: popup failed', error);
  showNotice('error', 'Clean Copy failed to start', 'Close and reopen the popup.');
});
