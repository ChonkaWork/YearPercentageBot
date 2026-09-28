import { errorLabel, isTransient } from '../core/errors';
import { sanitizeHistory, trend, visibleHistory, type ValuePoint } from '../core/history';
import { noiseGroups, sanitizeNoise, type NoiseState } from '../core/noise';
import { MAX_SNAPSHOT_CHARS, normalizeText } from '../core/normalize';
import { extractNumbers } from '../core/numbers';
import { allowedInterval, canAddWatch, hasFeature, LIMIT_MESSAGE, limitsFor, type Plan } from '../core/plan';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../core/settings';
import { isInterval, type Change, type Watch, type WatchDraft } from '../core/types';
import { hostLabel, normalizeWatchUrl, originPattern, shortUrl } from '../core/url';
import { sanitizeChanges, sanitizeWatches, sortWatches, totalUnseen } from '../core/watch';
import type { CompleteAddResponse, PendingAdd, SimpleResponse } from '../platform/messages';
import {
  changesKey,
  CHECKING_KEY,
  clearPendingAdd,
  historyKey,
  loadChanges,
  loadChecking,
  loadHistories,
  loadNoise,
  loadPlan,
  loadSettings,
  loadWatches,
  noiseKey,
  planChanged,
  sanitizeChecking,
  setPendingAdd,
  SETTINGS_KEY,
  WATCHES_KEY,
  type CheckingState,
} from '../storage/store';
import { dayLabel, historyChart, sparkline } from '../ui/chart';
import { byId, h, icon } from '../ui/dom';
import { capitalize, dateTime, intervalLabel, intervalPhrase, MODE_OPTIONS, plural, proBadge, relativeTime } from '../ui/format';
import { ICONS } from '../ui/icons';
import { diffView } from './diff';
import { optionsForm, type OptionsForm, type PlanGate } from '../ui/optionsForm';
import { showToast } from './toast';

// The e2e suite opens this page in a normal tab, so it's told which tab to act on (and can
// simulate a denied permission prompt, which automation can't click). Compiled out of dist/.
const forcedTabId = __E2E__ && new URLSearchParams(location.search).has('tab') ? Number(new URLSearchParams(location.search).get('tab')) : null;

const els = {
  current: byId<HTMLElement>('current'),
  watches: byId<HTMLElement>('watches'),
  markAllSeen: byId<HTMLButtonElement>('mark-all-seen'),
  openOptions: byId<HTMLButtonElement>('open-options'),
  toasts: byId<HTMLElement>('toasts'),
};

interface TabInfo {
  id: number;
  /** Null for pages that can't be watched (chrome://, file://, the Web Store...). */
  url: string | null;
  title: string;
  /** Visible text of the live page, to detect JavaScript-rendered pages. */
  liveText: string | null;
}

type AddState =
  | { view: 'idle'; error?: string }
  | { view: 'form'; form: OptionsForm; busy: string | null; error?: string }
  | { view: 'picking'; busy: string | null };

let tab: TabInfo | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let plan: Plan = 'free';
let watches: Watch[] = [];
let checking: CheckingState = {};
let order: string[] | null = null;
let addState: AddState = { view: 'idle' };
let loadError: string | null = null;
/** Set once the first load finished; earlier storage events are covered by that load. */
let ready = false;
const expanded = new Set<string>();
const changesCache = new Map<string, Change[]>();
const selectedChange = new Map<string, string>();
const editing = new Map<string, { form: OptionsForm; busy: boolean; error?: string }>();
const confirmingDelete = new Map<string, number>();
/** Changes that were unseen when shown in this popup: they keep a "New" marker until it closes. */
const newInSession = new Set<string>();
/** Value histories of number and price watches (for the rows' value and sparkline). */
const histories = new Map<string, ValuePoint[]>();
/** Noise filters of expanded watches. */
const noiseCache = new Map<string, NoiseState>();
/** The page is already watched and the user asked to add another watch for it. */
let showAddChoices = false;

function send<T>(message: unknown): Promise<T | undefined> {
  return chrome.runtime.sendMessage(message).then(
    (response: unknown) => response as T | undefined,
    () => undefined,
  );
}

const FAILED = "Page Watch didn't respond. Please try again.";

// --- Loading --------------------------------------------------------------------------------

async function init(): Promise<void> {
  els.openOptions.append(icon(ICONS.gear, { size: 16 }));
  const [loadedTab, loadedSettings, loadedPlan, loadedWatches, loadedChecking] = await Promise.all([
    loadTab(),
    loadSettings(),
    loadPlan(),
    loadWatches().catch(() => {
      loadError = "Couldn't read your watches from browser storage.";
      return [] as Watch[];
    }),
    loadChecking(),
  ]);
  tab = loadedTab;
  settings = loadedSettings;
  plan = loadedPlan;
  watches = loadedWatches;
  checking = loadedChecking;
  try {
    for (const [id, points] of await loadHistories(watches.map((watch) => watch.id))) histories.set(id, points);
  } catch {
    // Rows fall back to the text summary.
  }

  // One watch with news: open it right away.
  const withNews = watches.filter((watch) => watch.unseen > 0);
  if (withNews.length === 1) await expand(withNews[0]!.id);
  ready = true;
  render();

  if (tab?.url) {
    tab.liveText = await readLiveText(tab.id);
    if (__E2E__) document.documentElement.dataset.liveText = tab.liveText === null ? 'none' : 'read';
  }
}

async function loadTab(): Promise<TabInfo | null> {
  try {
    const current =
      forcedTabId !== null ? await chrome.tabs.get(forcedTabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (current?.id === undefined) return null;
    return { id: current.id, url: normalizeWatchUrl(current.url), title: current.title ?? '', liveText: null };
  } catch {
    return null;
  }
}

/** activeTab lets the popup read the visible text of the page it was opened on. */
async function readLiveText(tabId: number): Promise<string | null> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => document.body?.innerText ?? '',
    });
    return typeof injection?.result === 'string' ? normalizeText(injection.result).slice(0, MAX_SNAPSHOT_CHARS) : null;
  } catch {
    return null;
  }
}

// --- Rendering ------------------------------------------------------------------------------

function render(): void {
  renderCurrent();
  renderWatches();
  els.markAllSeen.hidden = totalUnseen(watches) === 0;
}

let currentSignature = '';

function renderCurrent(): void {
  const empty = watches.length === 0 && !loadError;
  const already = tab?.url ? watches.filter((watch) => watch.url === tab!.url).length : 0;
  // Already watched: one line, the add buttons only on request.
  const compact = already > 0 && addState.view === 'idle' && !addState.error && !showAddChoices && !loadError;
  const signature = JSON.stringify([
    tab?.url,
    tab?.title,
    empty,
    loadError,
    already,
    compact,
    addState.view,
    canAdd(),
    'busy' in addState ? addState.busy : null,
    'error' in addState ? addState.error : null,
  ]);
  // Background updates (a check finishing) must not disturb someone typing in the form.
  if (signature === currentSignature) return;
  currentSignature = signature;

  const focused = document.activeElement;
  const refocus = focused instanceof HTMLElement && els.current.contains(focused) ? focused : null;
  const selection = refocus instanceof HTMLInputElement && refocus.type === 'text' ? [refocus.selectionStart, refocus.selectionEnd] : null;

  els.current.classList.toggle('is-compact', compact);
  if (compact) {
    const add = h(
      'button',
      {
        class: 'btn btn-link btn-sm p-0 ms-auto flex-none',
        attrs: { type: 'button', 'data-focus': 'add-another' },
        on: {
          click: () => {
            showAddChoices = true;
            renderCurrent();
            els.current.querySelector<HTMLElement>('[data-focus="watch-page"], [data-focus="about-pro"]')?.focus();
          },
        },
      },
      icon(ICONS.plus),
      'Add another',
    );
    els.current.replaceChildren(
      h(
        'div',
        { class: 'tab-watched' },
        icon(ICONS.watching, { class: 'text-success-emphasis' }),
        h('span', { class: 'min-w-0 text-truncate' }, h('strong', { text: 'Watching this page' }), already > 1 ? ` · ${plural(already, 'watch')}` : ''),
        add,
      ),
    );
    els.current.classList.add('border-bottom');
    if (refocus && !refocus.isConnected) add.focus();
    return;
  }

  const children: Node[] = [];
  if (loadError) children.push(alert('danger', loadError));
  if (empty && addState.view !== 'form') {
    children.push(
      h(
        'div',
        { class: 'empty-state mb-3' },
        h('div', { class: 'empty-icon' }, icon(ICONS.bell, { size: 22 })),
        h('h1', { class: 'h6 mb-1', text: 'Know when a page changes' }),
        h('p', {
          class: 'small text-body-secondary mb-0',
          text: 'Watch a whole page, or just the price, stock status or list you care about. Timestamps and other noise are filtered out.',
        }),
      ),
    );
  }

  const panel = h('div', { class: empty ? 'card card-body p-3' : '' });
  panel.append(h('span', { class: 'section-label', text: 'This tab' }));
  if (!tab?.url) {
    panel.append(
      h(
        'p',
        { class: 'small text-body-secondary mb-0 d-flex gap-2' },
        icon(ICONS.info, { class: 'mt-1' }),
        h('span', {
          text: "This page can't be watched. Open a web page (http or https), then click Page Watch again. Chrome's own pages and the Web Store are off limits to extensions.",
        }),
      ),
    );
  } else {
    panel.append(
      h('div', { class: 'tab-title text-truncate', text: tab.title || hostLabel(tab.url), attrs: { title: tab.title } }),
      h('div', { class: 'tab-url text-truncate', text: shortUrl(tab.url), attrs: { title: tab.url } }),
    );
    if (already > 0) {
      panel.append(
        h('div', { class: 'small text-success-emphasis mt-1 d-flex align-items-center gap-1' }, icon(ICONS.watching), `Watching this page · ${plural(already, 'watch')}`),
      );
    }
    panel.append(addControls());
  }
  children.push(panel);
  els.current.replaceChildren(...children);
  els.current.classList.toggle('border-bottom', !empty);
  if (refocus?.isConnected && document.activeElement !== refocus) {
    refocus.focus({ preventScroll: true });
    if (selection && refocus instanceof HTMLInputElement) refocus.setSelectionRange(selection[0] ?? null, selection[1] ?? null);
  }
}

function addControls(): HTMLElement {
  const wrapper = h('div', { class: 'mt-2' });
  if (addState.view === 'form') {
    const state = addState;
    const start = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'button', 'data-focus': 'start' } });
    if (state.busy) start.append(h('span', { class: 'spinner-border spinner-border-sm', attrs: { 'aria-hidden': 'true' } }), state.busy);
    else start.append(icon(ICONS.bell), 'Start watching');
    start.disabled = Boolean(state.busy);
    start.addEventListener('click', onStartWatching);
    const cancel = h('button', {
      class: 'btn btn-outline-secondary btn-sm',
      text: 'Cancel',
      attrs: { type: 'button' },
      on: { click: () => setAddState({ view: 'idle' }) },
    });
    cancel.disabled = Boolean(state.busy);
    state.form.setDisabled(Boolean(state.busy));
    wrapper.append(
      h('span', { class: 'section-label mt-3', text: 'New watch · whole page' }),
      state.form.element,
      h(
        'p',
        { class: 'form-hint d-flex gap-1 mt-2 mb-2' },
        icon(ICONS.privacy, { class: 'mt-1' }),
        h('span', {
          text: `Chrome will ask to let Page Watch read ${hostLabel(tab!.url!)}. It's only used to check the pages you watch there.`,
        }),
      ),
      h('div', { class: 'd-flex justify-content-end gap-2' }, cancel, start),
    );
    if (state.error) wrapper.insertBefore(alert('danger', state.error), wrapper.lastElementChild);
    return wrapper;
  }

  if (!canAdd() && addState.view === 'idle') {
    // Free plan at its limit: existing watches keep working, only adding is off.
    wrapper.append(
      h(
        'div',
        { class: 'limit-note small', attrs: { role: 'status' } },
        h('div', { class: 'd-flex align-items-center gap-2' }, proBadge(), h('span', { text: LIMIT_MESSAGE })),
        h(
          'div',
          { class: 'd-flex align-items-center gap-3 mt-1' },
          h('button', { class: 'btn btn-link btn-sm p-0', text: 'About Pro', attrs: { type: 'button', 'data-focus': 'about-pro' }, on: { click: openAboutPro } }),
          h('span', { class: 'text-body-secondary', text: 'Or delete a watch to add another.' }),
        ),
      ),
    );
    return wrapper;
  }

  const busy = addState.view === 'picking' ? addState.busy : null;
  const watchPage = h(
    'button',
    { class: 'btn btn-primary btn-sm flex-fill', attrs: { type: 'button', 'data-focus': 'watch-page' }, on: { click: openAddForm } },
    icon(ICONS.page),
    'Watch this page',
  );
  const pick = h('button', { class: 'btn btn-outline-secondary btn-sm flex-fill', attrs: { type: 'button', 'data-focus': 'pick' } });
  if (busy) pick.append(h('span', { class: 'spinner-border spinner-border-sm', attrs: { 'aria-hidden': 'true' } }), busy);
  else pick.append(icon(ICONS.pick), 'Pick an element…');
  pick.addEventListener('click', onPickElement);
  watchPage.disabled = pick.disabled = Boolean(busy);
  wrapper.append(h('div', { class: 'd-flex gap-2' }, watchPage, pick));
  if (addState.view === 'idle' && addState.error) wrapper.append(alert('danger', addState.error, 'mt-2 mb-0'));
  if (addState.view === 'picking' && !busy) {
    wrapper.append(alert('info', 'Pick the part to watch on the page. Press Esc there to cancel.', 'mt-2 mb-0'));
  }
  return wrapper;
}

function alert(tone: 'danger' | 'warning' | 'info' | 'success', message: string, extraClass = 'mb-2'): HTMLElement {
  const glyph = tone === 'danger' ? ICONS.danger : tone === 'warning' ? ICONS.warning : tone === 'success' ? ICONS.success : ICONS.info;
  return h(
    'div',
    { class: `alert alert-${tone} small d-flex gap-2 ${extraClass}`, attrs: { role: tone === 'danger' ? 'alert' : 'status' } },
    icon(glyph, { class: 'mt-1' }),
    h('div', { class: 'min-w-0', text: message }),
  );
}

function orderedWatches(): Watch[] {
  const byId = new Map(watches.map((watch) => [watch.id, watch]));
  if (!order) order = sortWatches(watches).map((watch) => watch.id);
  // Keep the order stable while the popup is open; new watches go on top.
  const fresh = sortWatches(watches.filter((watch) => !order!.includes(watch.id))).map((watch) => watch.id);
  order = [...fresh, ...order.filter((id) => byId.has(id))];
  return order.map((id) => byId.get(id)!);
}

function renderWatches(): void {
  els.watches.hidden = watches.length === 0;
  if (watches.length === 0) {
    els.watches.replaceChildren();
    return;
  }
  let label = els.watches.querySelector<HTMLElement>('.section-label');
  let list = els.watches.querySelector<HTMLElement>('.watch-list');
  if (!label || !list) {
    label = h('span', { class: 'section-label mt-3' });
    list = h('div', { class: 'list-group watch-list', attrs: { role: 'list' } });
    els.watches.replaceChildren(label, list);
  }
  const { maxWatches } = limitsFor(plan);
  // "2 of 3" while under the free limit; over it (watches from Pro or early access) just the count.
  label.textContent = Number.isFinite(maxWatches) && watches.length <= maxWatches ? `Watching · ${watches.length} of ${maxWatches}` : `Watching · ${watches.length}`;

  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusKey = focused?.dataset.focus ? `${focused.closest<HTMLElement>('[data-id]')?.dataset.id}:${focused.dataset.focus}` : null;

  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(list.children)) existing.set((child as HTMLElement).dataset.id ?? '', child as HTMLElement);
  const minute = Math.floor(Date.now() / 30_000);
  const nodes = orderedWatches().map((watch) => {
    const points = histories.get(watch.id);
    const signature = JSON.stringify([
      watch,
      minute,
      settings.sound,
      plan,
      points?.length,
      points?.[points.length - 1],
      noiseCache.get(watch.id),
      expanded.has(watch.id),
      Boolean(checking[watch.id]),
      changesCache.get(watch.id)?.map((change) => [change.id, change.seen]),
      selectedChange.get(watch.id),
      editing.has(watch.id) ? [editing.get(watch.id)!.busy, editing.get(watch.id)!.error] : null,
      confirmingDelete.has(watch.id),
    ]);
    const old = existing.get(watch.id);
    if (old && old.dataset.signature === signature) return old;
    const node = renderWatch(watch);
    node.dataset.signature = signature;
    return node;
  });

  nodes.forEach((node, index) => {
    if (list!.children[index] !== node) list!.insertBefore(node, list!.children[index] ?? null);
  });
  while (list.children.length > nodes.length) list.lastElementChild!.remove();

  // Re-rendered rows lose focus; put it back on the same control.
  if (focused && !focused.isConnected && focusKey) {
    const [id, key] = focusKey.split(':');
    list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id ?? '')}"] [data-focus="${CSS.escape(key ?? '')}"]`)?.focus();
  } else if (focused?.isConnected && document.activeElement !== focused) {
    focused.focus();
  }
}

function statusIcon(watch: Watch, isChecking: boolean): Node {
  if (isChecking) return h('span', { class: 'spinner-border spinner-border-sm text-secondary', attrs: { role: 'status', 'aria-label': 'Checking' } });
  if (watch.error) {
    const transient = isTransient(watch.error);
    return icon(transient ? ICONS.warning : ICONS.danger, { class: transient ? 'text-warning' : 'text-danger', label: 'Problem' });
  }
  if (watch.paused) return icon(ICONS.paused, { class: 'text-body-secondary', label: 'Paused' });
  if (watch.status === 'pending') return icon(ICONS.pending, { class: 'text-body-secondary', label: 'Waiting' });
  return h('span', { class: 'status-dot', attrs: { role: 'img', 'aria-label': watch.unseen ? 'Changed' : 'Up to date' } });
}

function statusLine(watch: Watch, isChecking: boolean, isValue: boolean): HTMLElement | null {
  if (isChecking) return h('span', { class: 'watch-line text-body-secondary', text: 'Checking now…' });
  if (watch.error) {
    const tone = isTransient(watch.error) ? 'text-warning-emphasis' : 'text-danger-emphasis';
    return h('span', { class: `watch-line ${tone}`, text: `${errorLabel(watch.error)} · ${relativeTime(watch.error.at)}` });
  }
  // Number and price watches show their value instead; paused shows as a badge.
  if (isValue) return null;
  if (watch.unseen > 0 && watch.lastSummary && watch.lastChangedAt) {
    return h('span', { class: 'watch-line is-summary', text: `${watch.lastSummary} · ${relativeTime(watch.lastChangedAt)}` });
  }
  if (watch.paused) return h('span', { class: 'watch-line text-body-secondary', text: 'Paused' });
  if (!watch.lastCheckedAt) return h('span', { class: 'watch-line text-body-secondary', text: 'Waiting for the first check' });
  const checked = `checked ${relativeTime(watch.lastCheckedAt)}`;
  const text = watch.lastChangedAt ? `Changed ${relativeTime(watch.lastChangedAt)} · ${checked}` : `No changes yet · ${checked}`;
  return h('span', { class: 'watch-line', text });
}

/** A value written with a currency (symbol or code) is a price. */
function isPriceText(raw: string): boolean {
  return extractNumbers(raw)[0]?.isPrice ?? false;
}

/** "$99.00 ↓ from $129.00" with a sparkline: the row of a number or price watch. */
function valueRow(watch: Watch, points: readonly ValuePoint[]): HTMLElement | null {
  const info = trend(points);
  if (!info) return null;
  const price = isPriceText(info.current.r);
  const row = h('span', { class: 'watch-value-row' }, h('span', { class: 'watch-value', text: info.current.r }));
  if (info.previous) {
    const down = info.direction === 'down';
    // For prices down is good news; for other numbers the direction is only shown.
    const tone = price ? (down ? 'is-good' : 'is-bad') : '';
    row.append(
      h(
        'span',
        { class: `watch-delta ${tone}` },
        icon(down ? ICONS.down : ICONS.up, { label: down ? 'Down' : 'Up' }),
        h('span', { text: `from ${info.previous.r}` }),
      ),
    );
  } else if (watch.lastCheckedAt) {
    row.append(h('span', { class: 'watch-delta', text: `since ${dayLabel(points[0]!.t)}` }));
  }
  if (points.length > 1) {
    row.append(sparkline(points, `${price ? 'Price' : 'Value'} over the last ${plural(Math.min(points.length, 30), 'check')}: ${points[Math.max(0, points.length - 30)]!.r} to ${info.current.r}`));
  }
  return row;
}

function metaLine(watch: Watch, isValue: boolean): string {
  const parts = [hostLabel(watch.url)];
  if (!isValue) parts.push(watch.selector ? 'Element' : 'Whole page');
  parts.push(`every ${intervalLabel(watch.intervalMinutes)}`);
  if (isValue && watch.lastCheckedAt && !watch.error) parts.push(`checked ${relativeTime(watch.lastCheckedAt)}`);
  if (watch.noisyLines > 0) parts.push(`${plural(watch.noisyLines, 'noisy line')} ignored`);
  return parts.join(' · ');
}

function renderWatch(watch: Watch): HTMLElement {
  const isExpanded = expanded.has(watch.id);
  const isChecking = Boolean(checking[watch.id]);
  const bodyId = `watch-body-${watch.id}`;
  const classes = ['list-group-item', 'watch'];
  if (watch.unseen > 0) classes.push('is-unseen');

  const title = h('span', { class: 'watch-title-row' }, h('span', { class: 'watch-name', text: watch.name }));
  if (watch.unseen > 0) title.append(h('span', { class: 'badge rounded-pill text-bg-primary', text: `${watch.unseen} new` }));
  if (watch.paused) title.append(h('span', { class: 'badge rounded-pill text-bg-secondary', text: 'Paused' }));

  const points = histories.get(watch.id);
  const value = points && points.length > 0 ? valueRow(watch, points) : null;
  const toggle = h(
    'button',
    {
      class: 'watch-toggle',
      attrs: { type: 'button', 'aria-expanded': String(isExpanded), 'aria-controls': bodyId, 'data-focus': 'toggle' },
      on: { click: () => void toggleWatch(watch.id) },
    },
    h('span', { class: 'watch-status' }, statusIcon(watch, isChecking)),
    h('span', { class: 'watch-main' }, title, value, statusLine(watch, isChecking, value !== null), h('span', { class: 'watch-meta', text: metaLine(watch, value !== null) })),
    icon(ICONS.chevronDown, { class: 'watch-chevron' }),
  );

  const item = h('div', { class: classes.join(' '), attrs: { 'data-id': watch.id, role: 'listitem' } }, toggle);
  if (isExpanded) item.append(renderBody(watch, bodyId, isChecking));
  return item;
}

function actionButton(
  label: string,
  glyph: string,
  focusKey: string,
  onClick: () => void,
  options: { tone?: string; iconOnly?: boolean } = {},
): HTMLButtonElement {
  const button = h(
    'button',
    { class: `btn btn-sm ${options.tone ?? 'btn-outline-secondary'}`, attrs: { type: 'button', 'data-focus': focusKey }, on: { click: onClick } },
    icon(glyph),
  );
  if (options.iconOnly) {
    button.classList.add('btn-square');
    button.setAttribute('aria-label', label);
    button.title = label;
  } else {
    button.append(label);
  }
  return button;
}

function renderBody(watch: Watch, bodyId: string, isChecking: boolean): HTMLElement {
  const body = h('div', { class: 'watch-body', attrs: { id: bodyId } });
  const edit = editing.get(watch.id);
  if (edit) {
    body.append(renderEditForm(watch, edit));
    return body;
  }

  const check = actionButton('Check now', ICONS.arrowClockwise, 'check', () => void checkNow(watch.id));
  check.disabled = isChecking;
  const pause = watch.paused
    ? actionButton('Resume', ICONS.play, 'pause', () => void setPaused(watch.id, false))
    : actionButton('Pause', ICONS.pause, 'pause', () => void setPaused(watch.id, true));
  const confirming = confirmingDelete.has(watch.id);
  const remove = confirming
    ? actionButton('Confirm delete', ICONS.trash, 'delete', () => void onDelete(watch), { tone: 'btn-danger' })
    : actionButton('Delete', ICONS.trash, 'delete', () => void onDelete(watch), { tone: 'btn-outline-danger', iconOnly: true });
  // The per-watch sound switch, when sounds are on in Settings.
  const sound = settings.sound
    ? actionButton(watch.sound ? 'Sound on for this watch' : 'Sound off for this watch', watch.sound ? ICONS.soundOn : ICONS.soundOff, 'sound', () => void setSound(watch), {
        iconOnly: true,
      })
    : null;
  sound?.setAttribute('aria-pressed', String(watch.sound));
  body.append(
    h(
      'div',
      { class: 'watch-actions d-flex flex-wrap gap-1 mb-2' },
      check,
      pause,
      actionButton('Edit', ICONS.edit, 'edit', () => startEdit(watch)),
      h(
        'span',
        { class: 'ms-auto d-flex gap-1' },
        sound,
        actionButton('Open page', ICONS.open, 'open', () => void openPage(watch), { iconOnly: true }),
        remove,
      ),
    ),
  );

  if (watch.error) body.append(errorAlert(watch));
  const history = renderHistory(watch);
  if (history) body.append(history);

  const mode = MODE_OPTIONS.find((option) => option.value === watch.mode)!;
  const next = watch.paused ? 'paused' : watch.nextCheckAt ? relativeTime(watch.nextCheckAt) : '—';
  body.append(
    h(
      'dl',
      { class: 'watch-facts mb-2' },
      h('dt', { text: 'Page' }),
      h('dd', {}, h('a', { class: 'link-body-emphasis', text: shortUrl(watch.url), attrs: { href: watch.url, target: '_blank', rel: 'noreferrer' } })),
      h('dt', { text: 'Watching' }),
      h('dd', {}, watch.selector ? h('code', { class: 'mono', text: watch.selector }) : 'Whole page'),
      h('dt', { text: 'Notify when' }),
      h('dd', {
        text:
          watch.mode === 'keyword'
            ? `“${watch.keyword}” appears or disappears`
            : watch.mode === 'below'
              ? `The price drops below ${watch.target}`
              : mode.label,
      }),
      h('dt', { text: 'Checks' }),
      h('dd', { text: `${capitalize(intervalPhrase(watch.intervalMinutes))} · last ${watch.lastCheckedAt ? relativeTime(watch.lastCheckedAt) : 'never'} · next ${next}` }),
      h('dt', { text: 'Noise filter' }),
      h('dd', { text: noiseFact(watch) }),
    ),
  );

  const noise = renderNoise(watch);
  if (noise) body.append(noise);
  body.append(renderChanges(watch));
  return body;
}

function noiseFact(watch: Watch): string {
  const state = noiseCache.get(watch.id);
  if (!state) return watch.noisyLines ? `Ignoring ${plural(watch.noisyLines, 'line')}` : '…';
  if (state.phase === 'pair') return 'Learning: a second look at the page in a few seconds';
  if (!watch.noisyLines) return 'Nothing ignored: no line changed on its own';
  const ignoring = `Ignoring ${plural(watch.noisyLines, 'line')} that change${watch.noisyLines === 1 ? 's' : ''} on every check`;
  return state.phase === 'confirm' ? `${ignoring} · confirming over the next ${plural(state.checksLeft, 'check')}` : ignoring;
}

/** The lines the noise filter ignores, each with "Watch again". */
function renderNoise(watch: Watch): HTMLElement | null {
  const state = noiseCache.get(watch.id);
  const groups = state ? noiseGroups(state.rules) : [];
  if (groups.length === 0) return null;
  const list = h('ul', { class: 'list-group noise-list mb-2', attrs: { 'aria-label': 'Ignored lines' } });
  for (const group of groups) {
    const where =
      group.kind === 'order'
        ? `Order of ${plural(group.lines, 'item')}${group.anchor ? ` after “${group.anchor}”` : ''}; new or removed items still count`
        : group.kind === 'block'
          ? `${plural(group.lines, 'line')}${group.anchor ? ` after “${group.anchor}”` : ''}`
          : 'Only the “…” part is ignored';
    list.append(
      h(
        'li',
        { class: 'list-group-item noise-item' },
        icon(ICONS.ignored, { class: 'noise-icon' }),
        h('span', { class: 'noise-text' }, h('span', { class: 'noise-line', text: group.text }), h('span', { class: 'noise-where', text: where })),
        h('button', {
          class: 'btn btn-sm btn-outline-secondary flex-none',
          text: 'Watch again',
          attrs: { type: 'button', 'data-focus': `unignore-${group.id}`, 'aria-label': `Watch again: ${group.text}` },
          on: { click: () => void onUnignore(watch, group.id) },
        }),
      ),
    );
  }
  return h(
    'div',
    {},
    h('span', { class: 'section-label d-flex align-items-center gap-1' }, icon(ICONS.noise, { size: 12 }), 'Ignored · changes on every check'),
    list,
  );
}

/** Number and price watches: the value's history (Pro: all of it; free: the last 7 days). */
function renderHistory(watch: Watch): HTMLElement | null {
  const points = histories.get(watch.id);
  if (!points || points.length === 0) return null;
  const price = isPriceText(points[points.length - 1]!.r);
  const noun = price ? 'Price' : 'Value';
  const full = hasFeature(plan, 'full-history');
  const visible = visibleHistory(points, full, Date.now());
  const section = h('div', { class: 'history mb-2' });
  section.append(h('span', { class: 'section-label', text: `${noun} history · since ${dayLabel(visible[0]!.t)}` }));
  if (visible.length < 2) {
    section.append(h('p', { class: 'small text-body-secondary mb-0', text: `${noun} ${points[0]!.r} at the first check. The chart fills in as Page Watch checks.` }));
    return section;
  }
  section.append(historyChart(visible, { noun }));
  if (visible.length < points.length) {
    section.append(
      h(
        'p',
        { class: 'form-hint d-flex flex-wrap align-items-center gap-1 mt-1 mb-0 pro-hint' },
        proBadge(),
        h('span', { text: 'Showing the last 7 days. The full history is part of Pro.' }),
        h('button', { class: 'btn btn-link btn-sm p-0 align-baseline', text: 'About Pro', attrs: { type: 'button' }, on: { click: openAboutPro } }),
      ),
    );
  }
  return section;
}

function errorAlert(watch: Watch): HTMLElement {
  const error = watch.error!;
  const transient = isTransient(error);
  const box = alert(transient ? 'warning' : 'danger', error.message, 'mb-2');
  const content = box.lastElementChild as HTMLElement;
  if (transient && !watch.paused && watch.nextCheckAt) {
    content.append(h('div', { class: 'small opacity-75 mt-1', text: `Failed ${plural(watch.errorCount, 'time')} in a row. Next try ${relativeTime(watch.nextCheckAt)}.` }));
  }
  if (error.code === 'permission') {
    content.append(
      h(
        'button',
        { class: 'btn btn-sm btn-primary mt-2', attrs: { type: 'button', 'data-focus': 'grant' }, on: { click: () => onGrantAccess(watch) } },
        icon(ICONS.key),
        `Allow access to ${hostLabel(watch.url)}`,
      ),
    );
  }
  return box;
}

function renderChanges(watch: Watch): HTMLElement {
  const changes = changesCache.get(watch.id);
  if (!changes) {
    return h('div', { class: 'placeholder-glow', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'placeholder col-12 placeholder-lg' }));
  }
  if (changes.length === 0) {
    return h('p', {
      class: 'small text-body-secondary mb-0',
      text: 'No changes yet. Each check is compared with the previous one; differences show up here.',
    });
  }
  const selectedId = selectedChange.get(watch.id) ?? changes[0]!.id;
  const selected = changes.find((change) => change.id === selectedId) ?? changes[0]!;
  const heading = selected === changes[0] ? 'Latest change' : 'Change';
  const wrapper = h(
    'div',
    {},
    h(
      'div',
      { class: 'd-flex align-items-baseline gap-2' },
      h('span', { class: 'section-label', text: `${heading} · ${dateTime(selected.at)}` }),
      newInSession.has(selected.id) ? h('span', { class: 'badge text-bg-primary', text: 'New' }) : null,
    ),
    diffView(selected, {
      activeRules: new Map((noiseCache.get(watch.id)?.rules ?? []).map((rule) => [rule.id, rule.kind])),
      onUnignore: (ruleId) => void onUnignore(watch, ruleId),
    }),
  );
  if (changes.length > 1) {
    const list = h('div', { class: 'list-group change-list mt-2', attrs: { role: 'list', 'aria-label': 'Earlier changes' } });
    for (const change of changes) {
      const active = change.id === selected.id;
      list.append(
        h(
          'button',
          {
            class: `list-group-item list-group-item-action${active ? ' active' : ''}`,
            attrs: { type: 'button', 'aria-current': String(active), 'data-focus': `change-${change.id}` },
            on: {
              click: () => {
                selectedChange.set(watch.id, change.id);
                render();
              },
            },
          },
          h('span', { class: 'change-when', text: dateTime(change.at) }),
          h('span', { class: 'change-summary', text: change.summary }),
          newInSession.has(change.id) ? h('span', { class: `badge ${active ? 'text-bg-light' : 'text-bg-primary'}`, text: 'New' }) : null,
        ),
      );
    }
    wrapper.append(h('span', { class: 'section-label mt-3', text: `History · last ${changes.length}` }), list);
  }
  return wrapper;
}

function renderEditForm(watch: Watch, edit: { form: OptionsForm; busy: boolean; error?: string }): HTMLElement {
  const save = h('button', { class: 'btn btn-primary btn-sm', attrs: { type: 'button', 'data-focus': 'save' } });
  if (edit.busy) save.append(h('span', { class: 'spinner-border spinner-border-sm', attrs: { 'aria-hidden': 'true' } }), 'Saving…');
  else save.append(icon(ICONS.check), 'Save');
  save.disabled = edit.busy;
  save.addEventListener('click', () => void saveEdit(watch.id));
  const cancel = h('button', {
    class: 'btn btn-outline-secondary btn-sm',
    text: 'Cancel',
    attrs: { type: 'button', 'data-focus': 'cancel-edit' },
    on: {
      click: () => {
        editing.delete(watch.id);
        render();
      },
    },
  });
  edit.form.setDisabled(edit.busy);
  return h(
    'div',
    {},
    h('span', { class: 'section-label', text: 'Edit watch' }),
    edit.form.element,
    edit.error ? alert('danger', edit.error, 'mt-2 mb-0') : null,
    h('div', { class: 'd-flex justify-content-end gap-2 mt-2' }, cancel, save),
  );
}

// --- Watch actions ----------------------------------------------------------------------------

async function expand(id: string): Promise<void> {
  expanded.add(id);
  if (!changesCache.has(id)) {
    try {
      changesCache.set(id, await loadChanges(id));
    } catch {
      changesCache.set(id, []);
    }
  }
  if (!noiseCache.has(id)) {
    try {
      noiseCache.set(id, await loadNoise(id));
    } catch {
      // The facts say "…" until it loads.
    }
  }
  const watch = watches.find((item) => item.id === id);
  if (watch && watch.unseen > 0) {
    for (const change of changesCache.get(id) ?? []) if (!change.seen) newInSession.add(change.id);
    void send<SimpleResponse>({ type: 'pw/mark-seen', id });
  }
}

async function toggleWatch(id: string): Promise<void> {
  if (expanded.has(id)) {
    expanded.delete(id);
    editing.delete(id);
  } else {
    await expand(id);
  }
  render();
}

async function checkNow(id: string): Promise<void> {
  checking = { ...checking, [id]: Date.now() };
  render();
  const response = await send<SimpleResponse>({ type: 'pw/check-now', id });
  if (!response?.ok) {
    const { [id]: _removed, ...rest } = checking;
    checking = rest;
    render();
    showToast(els.toasts, response?.message ?? FAILED, 'danger');
  }
}

async function setPaused(id: string, paused: boolean): Promise<void> {
  const response = await send<SimpleResponse>({ type: 'pw/set-paused', id, paused });
  if (!response?.ok) showToast(els.toasts, response?.message ?? FAILED, 'danger');
}

async function setSound(watch: Watch): Promise<void> {
  const response = await send<SimpleResponse>({ type: 'pw/update', id: watch.id, patch: { sound: !watch.sound } });
  if (!response?.ok) showToast(els.toasts, response?.message ?? FAILED, 'danger');
  else showToast(els.toasts, watch.sound ? `No sound for “${watch.name}”.` : `“${watch.name}” plays a sound when it changes.`);
}

async function onUnignore(watch: Watch, ruleId: string): Promise<void> {
  const response = await send<SimpleResponse>({ type: 'pw/unignore', id: watch.id, rule: ruleId });
  if (!response?.ok) {
    showToast(els.toasts, response?.message ?? FAILED, 'danger');
    return;
  }
  showToast(els.toasts, 'Watching it again: the next change there notifies you.');
  els.watches.querySelector<HTMLElement>(`[data-id="${CSS.escape(watch.id)}"] [data-focus="check"]`)?.focus();
}

function startEdit(watch: Watch): void {
  const form = optionsForm(
    `edit-${watch.id}`,
    { name: watch.name, intervalMinutes: watch.intervalMinutes, mode: watch.mode, keyword: watch.keyword, target: watch.target },
    planGate({ intervalMinutes: watch.intervalMinutes, mode: watch.mode }),
  );
  const edit: { form: OptionsForm; busy: boolean; error?: string } = { form, busy: false };
  // A validation message goes away as soon as the user fixes the field.
  form.element.addEventListener('input', () => {
    if (!edit.error) return;
    edit.error = undefined;
    render();
  });
  editing.set(watch.id, edit);
  render();
  form.focus();
}

async function saveEdit(id: string): Promise<void> {
  const edit = editing.get(id);
  if (!edit) return;
  const problem = edit.form.validate();
  if (problem) {
    edit.error = problem;
    render();
    return;
  }
  edit.busy = true;
  edit.error = undefined;
  render();
  const response = await send<SimpleResponse>({ type: 'pw/update', id, patch: edit.form.values() });
  if (response?.ok) {
    editing.delete(id);
    render();
    showToast(els.toasts, 'Saved.');
    els.watches.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] [data-focus="edit"]`)?.focus();
  } else {
    edit.busy = false;
    edit.error = response?.message ?? FAILED;
    render();
  }
}

async function onDelete(watch: Watch): Promise<void> {
  if (!confirmingDelete.has(watch.id)) {
    confirmingDelete.set(
      watch.id,
      window.setTimeout(() => {
        confirmingDelete.delete(watch.id);
        render();
      }, 4000),
    );
    render();
    return;
  }
  window.clearTimeout(confirmingDelete.get(watch.id));
  confirmingDelete.delete(watch.id);
  const response = await send<SimpleResponse>({ type: 'pw/delete', id: watch.id });
  if (response?.ok) {
    expanded.delete(watch.id);
    changesCache.delete(watch.id);
    showToast(els.toasts, `Deleted “${watch.name}”.`);
  } else {
    render();
    showToast(els.toasts, response?.message ?? FAILED, 'danger');
  }
}

async function openPage(watch: Watch): Promise<void> {
  if (watch.unseen > 0) await send<SimpleResponse>({ type: 'pw/mark-seen', id: watch.id });
  await chrome.tabs.create({ url: watch.url });
}

/** Must run inside the click: Chrome only shows permission prompts for a user gesture. */
function requestAccess(url: string): Promise<boolean> {
  if (__E2E__ && new URLSearchParams(location.search).has('deny')) return Promise.resolve(false);
  return chrome.permissions.request({ origins: [originPattern(url)] });
}

function onGrantAccess(watch: Watch): void {
  const request = requestAccess(watch.url);
  void request.then(
    async (granted) => {
      if (!granted) {
        showToast(els.toasts, `Page Watch still can't read ${hostLabel(watch.url)}. Allow access to keep watching it.`, 'danger');
        return;
      }
      await send<SimpleResponse>({ type: 'pw/access-granted', url: watch.url });
      showToast(els.toasts, 'Access granted. Checking again…');
    },
    () => showToast(els.toasts, FAILED, 'danger'),
  );
}

// --- Adding a watch --------------------------------------------------------------------------

function setAddState(state: AddState): void {
  addState = state;
  renderCurrent();
}

function canAdd(): boolean {
  return canAddWatch(plan, watches.length);
}

function planGate(keep?: PlanGate['keep']): PlanGate {
  return { plan, keep, onAboutPro: openAboutPro };
}

function openAboutPro(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#about-pro') });
}

function openAddForm(): void {
  if (!tab?.url || !canAdd()) return;
  const minimum = limitsFor(plan).minIntervalMinutes;
  const form = optionsForm(
    'new',
    {
      name: tab.title.trim() || hostLabel(tab.url),
      intervalMinutes: allowedInterval(plan, settings.defaultIntervalMinutes, isInterval(minimum) ? minimum : 60),
      mode: 'text',
      keyword: '',
      target: '',
    },
    planGate(),
  );
  // A validation message goes away as soon as the user fixes the field.
  form.element.addEventListener('input', () => {
    if (addState.view === 'form' && addState.form === form && addState.error && !addState.busy) setAddState({ ...addState, error: undefined });
  });
  setAddState({ view: 'form', form, busy: null });
  form.focus();
}

function deniedMessage(url: string): string {
  return `Page Watch needs access to ${hostLabel(url)} to check it in the background. Nothing was saved. Try again and choose Allow when Chrome asks.`;
}

function onStartWatching(): void {
  if (addState.view !== 'form' || !tab?.url || addState.busy) return;
  const state = addState;
  const problem = state.form.validate();
  if (problem) {
    setAddState({ ...state, error: problem });
    return;
  }
  const values = state.form.values();
  const draft: WatchDraft = { url: tab.url, selectors: [], liveText: tab.liveText, ...values };
  const pending: PendingAdd = { id: crypto.randomUUID(), kind: 'page', tabId: tab.id, url: tab.url, draft, createdAt: Date.now() };
  // Remembered first (not awaited, to keep the user gesture) in case the prompt closes the popup.
  void setPendingAdd(pending).catch(() => undefined);
  const request = requestAccess(tab.url);
  setAddState({ ...state, busy: 'Waiting for access…', error: undefined });
  void finishAdd(pending, request);
}

function onPickElement(): void {
  if (!tab?.url || (addState.view === 'picking' && addState.busy)) return;
  const pending: PendingAdd = { id: crypto.randomUUID(), kind: 'pick', tabId: tab.id, url: tab.url, createdAt: Date.now() };
  void setPendingAdd(pending).catch(() => undefined);
  const request = requestAccess(tab.url);
  setAddState({ view: 'picking', busy: 'Waiting for access…' });
  void finishAdd(pending, request);
}

async function finishAdd(pending: PendingAdd, request: Promise<boolean>): Promise<void> {
  const state = addState;
  const fail = (message: string) => {
    if (state.view === 'form') setAddState({ ...state, busy: null, error: message });
    else setAddState({ view: 'idle', error: message });
  };

  let granted = false;
  try {
    granted = await request;
  } catch {
    granted = false;
  }
  if (!granted) {
    void clearPendingAdd(pending.id);
    fail(deniedMessage(pending.url));
    return;
  }

  if (state.view === 'form') setAddState({ ...state, busy: 'Checking the page…' });
  else setAddState({ view: 'picking', busy: 'Opening the picker…' });
  const response = await send<CompleteAddResponse>({ type: 'pw/complete-add', pending });
  if (!response?.ok) {
    fail(response?.message ?? FAILED);
    return;
  }
  if (pending.kind === 'pick') {
    // The popup would cover the page; the picker takes over from here.
    if (forcedTabId === null) window.close();
    setAddState({ view: 'picking', busy: null });
    return;
  }
  showAddChoices = false;
  setAddState({ view: 'idle' });
  const name = response.watch?.name ?? hostLabel(pending.url);
  showToast(els.toasts, response.note ? `Watching “${name}”. ${response.note}` : `Watching “${name}”. You'll be notified when it changes.`);
}

// --- Live updates -----------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  let dirty = false;
  if (area === 'local') {
    if (changes[WATCHES_KEY]) {
      watches = sanitizeWatches(changes[WATCHES_KEY].newValue);
      loadError = null;
      dirty = true;
    }
    for (const [key, change] of Object.entries(changes)) {
      const [prefix, id = ''] = key.split(/:(.*)/s);
      if (key === changesKey(id) && prefix === 'changes') {
        if (change.newValue === undefined) changesCache.delete(id);
        else if (changesCache.has(id) || expanded.has(id)) changesCache.set(id, sanitizeChanges(change.newValue));
        dirty = true;
      } else if (key === historyKey(id)) {
        const points = sanitizeHistory(change.newValue);
        if (points.length) histories.set(id, points);
        else histories.delete(id);
        dirty = true;
      } else if (key === noiseKey(id)) {
        if (change.newValue === undefined) noiseCache.delete(id);
        else if (noiseCache.has(id) || expanded.has(id)) noiseCache.set(id, sanitizeNoise(change.newValue));
        dirty = true;
      }
    }
    if (changes[SETTINGS_KEY]) {
      settings = sanitizeSettings(changes[SETTINGS_KEY].newValue);
      dirty = true;
    }
  }
  if (area === 'local' && planChanged(changes)) {
    void loadPlan().then((loaded) => {
      plan = loaded;
      currentSignature = '';
      if (ready) render();
    });
  }
  if (area === 'session' && changes[CHECKING_KEY]) {
    checking = sanitizeChecking(changes[CHECKING_KEY].newValue);
    dirty = true;
  }
  if (dirty && ready) render();
});

els.openOptions.addEventListener('click', () => void chrome.runtime.openOptionsPage());
els.markAllSeen.addEventListener('click', () => {
  for (const watch of watches) {
    for (const change of changesCache.get(watch.id) ?? []) if (!change.seen) newInSession.add(change.id);
  }
  void send<SimpleResponse>({ type: 'pw/mark-seen', id: null });
});
// Relative times ("5 min ago") stay current while the popup is open.
window.setInterval(() => ready && renderWatches(), 30_000);

init().catch(() => {
  loadError = 'Page Watch failed to start. Try reopening it.';
  ready = true;
  render();
});
