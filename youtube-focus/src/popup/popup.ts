import gear from 'bootstrap-icons/icons/gear.svg';
import pauseIcon from 'bootstrap-icons/icons/pause-fill.svg';
import playIcon from 'bootstrap-icons/icons/play-fill.svg';
import { addChannel, channelLabel, findChannel, removeChannel, type AllowedChannel } from '../core/channels';
import { focusStatus, type Access, type FocusStatus } from '../core/focus';
import { EARLY_ACCESS, limitsFor, proMessage, type ProFeature } from '../core/plan';
import { describeSchedule, formatWhen } from '../core/schedule';
import { FEATURE_LABELS, FEATURES, PAUSE_MINUTES, pauseUntil, sanitizeSettings, type Feature, type HomeMode, type Settings } from '../core/settings';
import { applyClockChange, initClock, now } from '../platform/clock';
import { isPageResponse, type PageRequest, type PageResponse } from '../platform/messages';
import { can, isAccessChange, loadAccess, loadSettings, SETTINGS_KEY, updateSettings } from '../storage/store';
import { byId, h } from '../ui/dom';
import { icon } from '../ui/icons';

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  master: byId<HTMLElement>('master'),
  enabled: byId<HTMLInputElement>('enabled'),
  status: byId<HTMLSpanElement>('status'),
  statusText: byId<HTMLSpanElement>('status-text'),
  pause: byId<HTMLButtonElement>('pause'),
  hiddenCount: byId<HTMLSpanElement>('hidden-count'),
  features: byId<HTMLUListElement>('features'),
  subsOnly: byId<HTMLInputElement>('subs-only'),
  channelRow: byId<HTMLLIElement>('channel-row'),
  channelName: byId<HTMLSpanElement>('channel-name'),
  channelAllow: byId<HTMLInputElement>('channel-allow'),
  scheduleText: byId<HTMLSpanElement>('schedule-text'),
  editSchedule: byId<HTMLButtonElement>('edit-schedule'),
  proNote: byId<HTMLParagraphElement>('pro-note'),
  error: byId<HTMLDivElement>('error'),
};

let settings: Settings = sanitizeSettings(undefined);
let access: Access = { plan: 'free', earlyAccess: EARLY_ACCESS };
let page: PageResponse | null = null;
let tabId: number | null = null;
const switches = new Map<Feature, HTMLInputElement>();
const modeButtons = new Map<HomeMode, HTMLButtonElement>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showError(text: string | null): void {
  els.error.hidden = text === null;
  els.error.textContent = text ?? '';
}

async function change(patch: (current: Settings) => Partial<Settings>): Promise<void> {
  try {
    settings = await updateSettings(patch);
    showError(null);
  } catch (error) {
    showError(`Couldn't save: ${errorMessage(error)}`);
  }
  render();
}

// --- Rendering --------------------------------------------------------------------------------

function statusLine(status: FocusStatus): string {
  const time = now();
  switch (status.state) {
    case 'off':
      return 'Off: YouTube is shown as usual';
    case 'paused':
      return `Paused until ${formatWhen(status.until ?? time, time)}`;
    case 'outside-schedule':
      return status.until ? `Off until ${formatWhen(status.until, time)}` : 'Off by your schedule';
    case 'on': {
      const on = settings.subscriptionsOnly && can(access, 'subscriptions-only') ? 'Subscriptions only' : 'On';
      return status.until ? `${on} · until ${formatWhen(status.until, time)}` : on;
    }
  }
}

function hiddenCountText(): string {
  if (settings.subscriptionsOnly && can(access, 'subscriptions-only')) return 'Everything';
  const count = FEATURES.filter((feature) => settings.hide[feature]).length;
  return count === 0 ? 'Nothing selected' : `${count} of ${FEATURES.length}`;
}

function render(): void {
  const status = focusStatus(settings, access, now());
  els.enabled.checked = settings.enabled;
  els.master.classList.toggle('is-on', status.state === 'on');
  els.status.dataset.state = status.state;
  els.statusText.textContent = statusLine(status);
  els.status.title = status.state === 'outside-schedule' ? 'Outside your focus schedule' : '';
  els.hiddenCount.textContent = settings.enabled ? hiddenCountText() : '';

  const paused = status.state === 'paused';
  els.pause.replaceChildren(icon(paused ? playIcon : pauseIcon, { size: 14, class: 'me-1' }), paused ? 'Resume now' : `Pause ${PAUSE_MINUTES} min`);
  els.pause.disabled = !settings.enabled;
  els.pause.className = paused ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary';

  const strict = settings.subscriptionsOnly && can(access, 'subscriptions-only');
  for (const [feature, input] of switches) {
    input.checked = strict || settings.hide[feature];
    input.disabled = strict;
  }
  for (const [mode, button] of modeButtons) {
    button.setAttribute('aria-checked', String(settings.homeMode === mode));
    button.disabled = strict || !settings.hide.home;
  }

  // Pro
  const locked: ProFeature[] = [];
  els.subsOnly.checked = settings.subscriptionsOnly;
  els.subsOnly.disabled = !can(access, 'subscriptions-only');
  if (!can(access, 'subscriptions-only')) locked.push('subscriptions-only');

  const channel = page?.channel ?? null;
  els.channelRow.hidden = channel === null;
  if (channel) {
    const allowed = findChannel(settings.allowlist, channel) !== null;
    els.channelName.textContent = [channel.name, channelLabel(channel)].filter(Boolean).join(' · ');
    els.channelAllow.checked = allowed;
    els.channelAllow.disabled = !can(access, 'allowlist');
    if (!can(access, 'allowlist')) locked.push('allowlist');
  }

  const schedule = settings.schedule;
  els.scheduleText.textContent = !can(access, 'schedule')
    ? 'focus only during set hours'
    : schedule.enabled
      ? describeSchedule(schedule)
      : 'off: always focused';
  if (!can(access, 'schedule') && schedule.enabled) locked.push('schedule');

  els.proNote.hidden = locked.length === 0;
  els.proNote.textContent = locked.length ? proMessage(locked[0]!) : '';
}

function buildFeatureList(): void {
  for (const feature of FEATURES) {
    const id = `hide-${feature}`;
    const input = h('input', {
      class: 'form-check-input',
      attrs: { id, type: 'checkbox', role: 'switch', 'data-feature': feature },
      on: { change: () => void change((current) => ({ hide: { ...current.hide, [feature]: input.checked } })) },
    });
    switches.set(feature, input);
    // The popup keeps rows to one line; the longer explanation is the row's tooltip.
    const text = h('label', { class: 'text', attrs: { for: id, title: FEATURE_LABELS[feature].text } }, h('span', { class: 'title', text: FEATURE_LABELS[feature].title }));
    const row = h('li', { class: 'list-group-item switch-row' }, text);
    if (feature === 'home') {
      // Instead of the feed: a calm page, or straight to Subscriptions.
      const group = h('div', { class: 'home-mode btn-group', attrs: { role: 'radiogroup', 'aria-label': 'Instead of the home feed' } });
      const modes: [HomeMode, string, string][] = [
        ['calm', 'Calm page', 'Show a calm page with links to Subscriptions and Watch later'],
        ['subscriptions', 'Subscriptions', 'Go straight to Subscriptions'],
      ];
      for (const [mode, label, title] of modes) {
        const button = h('button', {
          class: 'btn btn-choice',
          text: label,
          attrs: { type: 'button', role: 'radio', title, 'data-mode': mode, 'aria-checked': 'false' },
          on: { click: () => void change(() => ({ homeMode: mode })) },
        });
        modeButtons.set(mode, button);
        group.append(button);
      }
      row.append(group);
    }
    row.append(h('div', { class: 'form-check form-switch' }, input));
    els.features.append(row);
  }
}

// --- Page info --------------------------------------------------------------------------------

/** The tab the popup is about: the active one. The e2e build can point it at a tab with ?tab=. */
async function resolveTab(): Promise<number | null> {
  if (__E2E__) {
    const param = new URLSearchParams(location.search).get('tab');
    if (param) return Number(param);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function loadPage(): Promise<void> {
  if (tabId === null) return;
  try {
    const request: PageRequest = { type: 'ytf/page' };
    const response: unknown = await chrome.tabs.sendMessage(tabId, request);
    page = isPageResponse(response) ? response : null;
  } catch {
    // Not a YouTube tab (no content script there): the channel row just stays hidden.
    page = null;
  }
}

async function setChannelAllowed(allowed: boolean): Promise<void> {
  const channel: AllowedChannel | null = page?.channel ?? null;
  if (!channel) return;
  const { maxAllowedChannels } = limitsFor(access.plan, access.earlyAccess);
  await change((current) => ({
    allowlist: allowed ? addChannel(current.allowlist, channel, channel.name, maxAllowedChannels) : removeChannel(current.allowlist, channel),
  }));
}

// --- Setup ------------------------------------------------------------------------------------

async function init(): Promise<void> {
  els.openOptions.append(icon(gear, { size: 16 }));
  buildFeatureList();
  els.openOptions.addEventListener('click', () => void chrome.runtime.openOptionsPage());
  els.editSchedule.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#schedule') });
  });
  els.enabled.addEventListener('change', () => void change(() => ({ enabled: els.enabled.checked })));
  els.pause.addEventListener('click', () => {
    const paused = focusStatus(settings, access, now()).state === 'paused';
    void change(() => ({ pausedUntil: paused ? 0 : pauseUntil(now()) }));
  });
  els.subsOnly.addEventListener('change', () => void change(() => ({ subscriptionsOnly: els.subsOnly.checked })));
  els.channelAllow.addEventListener('change', () => void setChannelAllowed(els.channelAllow.checked));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const clock = applyClockChange(changes);
    if (SETTINGS_KEY in changes) settings = sanitizeSettings(changes[SETTINGS_KEY]?.newValue);
    if (isAccessChange(changes)) {
      void loadAccess().then((next) => {
        access = next;
        render();
      });
    }
    if (clock || SETTINGS_KEY in changes) render();
  });
  // The status line mentions times ("Paused until 14:32"): keep it current while open.
  window.setInterval(render, 15_000);

  try {
    [settings, access] = await Promise.all([loadSettings(), loadAccess(), initClock()]);
  } catch (error) {
    showError(`Couldn't read settings, showing defaults: ${errorMessage(error)}`);
  }
  render();
  tabId = await resolveTab().catch(() => null);
  await loadPage();
  render();
}

init().catch((error: unknown) => showError(`Something went wrong: ${errorMessage(error)}`));
