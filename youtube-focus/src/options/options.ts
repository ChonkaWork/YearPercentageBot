import trash3 from 'bootstrap-icons/icons/trash3.svg';
import { addChannel, channelLabel, findChannel, parseChannelInput, removeChannel } from '../core/channels';
import { focusStatus, type Access } from '../core/focus';
import { EARLY_ACCESS, limitsFor, PRO_FEATURES, PRO_PRICE, proMessage } from '../core/plan';
import { DAY_NAMES, formatTime, formatWhen, isInWindow, nextChange, parseTime, WEEK_ORDER, type Schedule } from '../core/schedule';
import { FEATURE_LABELS, FEATURES, sanitizeSettings, type Feature, type Settings } from '../core/settings';
import { applyClockChange, initClock, now } from '../platform/clock';
import { can, isAccessChange, loadAccess, loadSettings, SETTINGS_KEY, updateSettings } from '../storage/store';
import { byId, h } from '../ui/dom';
import { icon } from '../ui/icons';

const els = {
  status: byId<HTMLSpanElement>('save-status'),
  enabled: byId<HTMLInputElement>('enabled'),
  focusStatus: byId<HTMLParagraphElement>('status'),
  focusStatusText: byId<HTMLSpanElement>('status-text'),
  features: byId<HTMLUListElement>('features'),
  homeMode: byId<HTMLFieldSetElement>('home-mode'),
  homeCalm: byId<HTMLInputElement>('home-calm'),
  homeSubscriptions: byId<HTMLInputElement>('home-subscriptions'),
  scheduleEnabled: byId<HTMLInputElement>('schedule-enabled'),
  scheduleFields: byId<HTMLFieldSetElement>('schedule-fields'),
  days: byId<HTMLDivElement>('days'),
  start: byId<HTMLInputElement>('start'),
  end: byId<HTMLInputElement>('end'),
  timeZone: byId<HTMLSelectElement>('time-zone'),
  scheduleStatus: byId<HTMLParagraphElement>('schedule-status'),
  scheduleStatusText: byId<HTMLSpanElement>('schedule-status-text'),
  schedulePro: byId<HTMLParagraphElement>('schedule-pro'),
  allowForm: byId<HTMLFormElement>('allow-form'),
  allowInput: byId<HTMLInputElement>('allow-input'),
  allowAdd: byId<HTMLButtonElement>('allow-add'),
  allowError: byId<HTMLDivElement>('allow-error'),
  allowlist: byId<HTMLUListElement>('allowlist'),
  allowlistEmpty: byId<HTMLParagraphElement>('allowlist-empty'),
  allowPro: byId<HTMLParagraphElement>('allow-pro'),
  subsOnly: byId<HTMLInputElement>('subs-only'),
  subsPro: byId<HTMLParagraphElement>('subs-pro'),
  proFeatures: byId<HTMLUListElement>('pro-features'),
  proPrice: byId<HTMLSpanElement>('pro-price'),
  proState: byId<HTMLSpanElement>('pro-state'),
};

let settings: Settings = sanitizeSettings(undefined);
let access: Access = { plan: 'free', earlyAccess: EARLY_ACCESS };
let statusTimer: number | undefined;
const switches = new Map<Feature, HTMLInputElement>();
const dayButtons = new Map<number, HTMLButtonElement>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Saving -----------------------------------------------------------------------------------

async function save(patch: (current: Settings) => Partial<Settings>): Promise<boolean> {
  try {
    settings = await updateSettings(patch);
    render();
    showStatus('Saved');
    return true;
  } catch (error) {
    showStatus(`Couldn't save: ${errorMessage(error)}`, true);
    render();
    return false;
  }
}

function saveSchedule(patch: Partial<Schedule>): Promise<boolean> {
  return save((current) => ({ schedule: { ...current.schedule, ...patch } }));
}

function showStatus(text: string, isError = false): void {
  window.clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
  if (!isError) statusTimer = window.setTimeout(() => (els.status.textContent = ''), 1800);
}

// --- Rendering --------------------------------------------------------------------------------

function render(): void {
  const time = now();
  const status = focusStatus(settings, access, time);
  els.enabled.checked = settings.enabled;
  els.focusStatus.dataset.state = status.state;
  els.focusStatusText.textContent = {
    on: 'On',
    off: 'Off: YouTube is shown as usual',
    paused: `Paused until ${formatWhen(status.until ?? time, time)}`,
    'outside-schedule': 'Waiting: outside your focus schedule',
  }[status.state];

  const strict = settings.subscriptionsOnly && can(access, 'subscriptions-only');
  for (const [feature, input] of switches) {
    input.checked = strict || settings.hide[feature];
    input.disabled = strict;
  }
  els.homeCalm.checked = settings.homeMode === 'calm';
  els.homeSubscriptions.checked = settings.homeMode === 'subscriptions';
  els.homeMode.disabled = strict || !settings.hide.home;

  renderSchedule(time);
  renderAllowlist();

  const subsAllowed = can(access, 'subscriptions-only');
  els.subsOnly.checked = settings.subscriptionsOnly;
  els.subsOnly.disabled = !subsAllowed;
  els.subsPro.hidden = subsAllowed;
  els.subsPro.textContent = subsAllowed ? '' : proMessage('subscriptions-only');

  els.proState.textContent = access.earlyAccess ? 'Free during early access' : access.plan === 'pro' ? 'You have Pro. Thank you!' : 'Payments aren’t set up yet';
}

function renderSchedule(time: number): void {
  const schedule = settings.schedule;
  const allowed = can(access, 'schedule');
  els.scheduleEnabled.checked = schedule.enabled;
  els.scheduleEnabled.disabled = !allowed;
  els.scheduleFields.disabled = !allowed;
  for (const [day, button] of dayButtons) button.setAttribute('aria-pressed', String(schedule.days.includes(day)));
  if (document.activeElement !== els.start) els.start.value = formatTime(schedule.start);
  if (document.activeElement !== els.end) els.end.value = formatTime(schedule.end);
  if (els.timeZone.value !== schedule.timeZone) {
    if (![...els.timeZone.options].some((option) => option.value === schedule.timeZone)) {
      els.timeZone.append(h('option', { text: schedule.timeZone, attrs: { value: schedule.timeZone } }));
    }
    els.timeZone.value = schedule.timeZone;
  }

  let state: string;
  let text: string;
  if (!allowed) {
    state = 'off';
    text = schedule.enabled ? 'Not applied on the free plan: focus mode is on all the time' : 'Off: focus mode is on all the time';
  } else if (!schedule.enabled) {
    state = 'off';
    text = 'Off: focus mode is on all the time';
  } else if (schedule.days.length === 0) {
    state = 'outside-schedule';
    text = 'No days chosen: focus mode never turns on';
  } else {
    const inside = isInWindow(schedule, time);
    const next = nextChange(schedule, time);
    const when = next === null ? '' : formatWhen(next, time, schedule.timeZone);
    state = inside ? 'on' : 'outside-schedule';
    text = inside ? `In focus hours now${when ? ` · until ${when}` : ''}` : `Outside focus hours${when ? ` · starts ${when}` : ''}`;
  }
  els.scheduleStatus.dataset.state = state;
  els.scheduleStatusText.textContent = text;
  els.schedulePro.hidden = allowed;
  els.schedulePro.textContent = allowed ? '' : proMessage('schedule');
}

function renderAllowlist(): void {
  const allowed = can(access, 'allowlist');
  const items = settings.allowlist.map((channel) =>
    h(
      'li',
      { class: 'list-group-item', attrs: { 'data-channel': channelLabel(channel) } },
      h('span', { class: 'who' }, h('span', { class: 'name', text: channel.name }), h('span', { class: 'handle', text: channelLabel(channel) })),
      h(
        'button',
        {
          class: 'btn btn-icon btn-sm',
          attrs: { type: 'button', 'aria-label': `Remove ${channel.name}`, title: 'Remove' },
          on: { click: () => void save((current) => ({ allowlist: removeChannel(current.allowlist, channel) })) },
        },
        icon(trash3, { size: 14 }),
      ),
    ),
  );
  els.allowlist.replaceChildren(...items);
  els.allowlist.hidden = items.length === 0;
  els.allowlistEmpty.hidden = items.length > 0;
  els.allowInput.disabled = !allowed;
  els.allowAdd.disabled = !allowed;
  els.allowPro.hidden = allowed;
  els.allowPro.textContent = allowed ? '' : proMessage('allowlist');
}

function showAllowError(text: string | null): void {
  els.allowError.hidden = text === null;
  els.allowError.textContent = text ?? '';
  els.allowInput.classList.toggle('is-invalid', text !== null);
}

// --- Setup ------------------------------------------------------------------------------------

function buildFeatureList(): void {
  for (const feature of FEATURES) {
    const id = `hide-${feature}`;
    const input = h('input', {
      class: 'form-check-input',
      attrs: { id, type: 'checkbox', role: 'switch', 'data-feature': feature },
      on: { change: () => void save((current) => ({ hide: { ...current.hide, [feature]: input.checked } })) },
    });
    switches.set(feature, input);
    els.features.append(
      h(
        'li',
        { class: 'list-group-item switch-row' },
        h(
          'label',
          { class: 'text', attrs: { for: id } },
          h('span', { class: 'title', text: FEATURE_LABELS[feature].title }),
          h('span', { class: 'hint', text: FEATURE_LABELS[feature].text }),
        ),
        h('div', { class: 'form-check form-switch' }, input),
      ),
    );
  }
}

function buildSchedule(): void {
  for (const day of WEEK_ORDER) {
    const button = h('button', {
      class: 'btn btn-choice',
      text: DAY_NAMES[day],
      attrs: { type: 'button', 'data-day': String(day), 'aria-pressed': 'false' },
      on: {
        click: () => {
          const days = settings.schedule.days.includes(day) ? settings.schedule.days.filter((entry) => entry !== day) : [...settings.schedule.days, day];
          void saveSchedule({ days });
        },
      },
    });
    dayButtons.set(day, button);
    els.days.append(button);
  }
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  els.timeZone.append(h('option', { text: `This computer${local ? ` (${local})` : ''}`, attrs: { value: '' } }));
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  for (const zone of zones.includes('UTC') ? zones : ['UTC', ...zones]) {
    els.timeZone.append(h('option', { text: zone.replaceAll('_', ' '), attrs: { value: zone } }));
  }
  const timeInput = (input: HTMLInputElement, key: 'start' | 'end') => {
    input.addEventListener('change', () => {
      const minutes = parseTime(input.value);
      if (minutes === null) {
        input.value = formatTime(settings.schedule[key]);
        return;
      }
      void saveSchedule({ [key]: minutes });
    });
  };
  timeInput(els.start, 'start');
  timeInput(els.end, 'end');
  els.timeZone.addEventListener('change', () => void saveSchedule({ timeZone: els.timeZone.value }));
  els.scheduleEnabled.addEventListener('change', () => void saveSchedule({ enabled: els.scheduleEnabled.checked }));
}

function buildPro(): void {
  els.proPrice.textContent = PRO_PRICE;
  for (const feature of PRO_FEATURES) {
    els.proFeatures.append(h('li', {}, h('strong', { text: feature.title }), ` · ${feature.text}`));
  }
}

async function init(): Promise<void> {
  buildFeatureList();
  buildSchedule();
  buildPro();

  els.enabled.addEventListener('change', () => void save(() => ({ enabled: els.enabled.checked })));
  for (const radio of [els.homeCalm, els.homeSubscriptions]) {
    radio.addEventListener('change', () => {
      if (radio.checked) void save(() => ({ homeMode: radio.value === 'subscriptions' ? 'subscriptions' : 'calm' }));
    });
  }
  els.subsOnly.addEventListener('change', () => void save(() => ({ subscriptionsOnly: els.subsOnly.checked })));

  els.allowForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = els.allowInput.value.trim();
    if (!raw) {
      showAllowError('Enter a channel: its @handle, its URL, or its UC… id.');
      return;
    }
    const channel = parseChannelInput(raw);
    if (!channel) {
      showAllowError(`“${raw}” doesn't look like a channel. Use its @handle, URL (youtube.com/@name) or UC… id.`);
      return;
    }
    if (findChannel(settings.allowlist, channel)) {
      showAllowError(`${channelLabel(channel)} is already on the list.`);
      return;
    }
    const { maxAllowedChannels } = limitsFor(access.plan, access.earlyAccess);
    if (settings.allowlist.length >= maxAllowedChannels) {
      showAllowError(`The list is full (${maxAllowedChannels} channels). Remove one first.`);
      return;
    }
    showAllowError(null);
    void save((current) => ({ allowlist: addChannel(current.allowlist, channel, '', maxAllowedChannels) })).then((ok) => {
      if (ok) els.allowInput.value = '';
    });
  });
  els.allowInput.addEventListener('input', () => showAllowError(null));

  // Changes made elsewhere (the popup, another settings tab) and the e2e clock.
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
  window.setInterval(render, 30_000);

  [settings, access] = await Promise.all([loadSettings(), loadAccess(), initClock()]);
  render();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

init().catch((error: unknown) => showStatus(`Couldn't load settings: ${errorMessage(error)}`, true));
