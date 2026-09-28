import checkLg from 'bootstrap-icons/icons/check-lg.svg';
import trash3 from 'bootstrap-icons/icons/trash3.svg';
import xLg from 'bootstrap-icons/icons/x-lg.svg';
import { normalizeHost } from '../core/hosts';
import {
  ACTION_IDS,
  ACTION_LABELS,
  DEFAULT_KEYS,
  eventCode,
  findConflict,
  isBindableCode,
  keyLabel,
  type ActionId,
  type KeyBindings,
} from '../core/keys';
import { GLOBAL_SPEED_KEY, parseGlobalSpeed } from '../core/memory';
import { EARLY_ACCESS, limitsFor, PRO_FEATURES, PRO_PRICE } from '../core/plan';
import { sanitizeSettings, SEEK_MAX, SEEK_MIN, STEP_MAX, STEP_MIN, type Settings } from '../core/settings';
import { addPreset, removePreset, removeSiteDefault, sortedSiteDefaults, upsertSiteDefault } from '../core/siteDefaults';
import { clampSpeed, formatSpeed, formatSpeedShort, MAX_SPEED, MIN_SPEED, PRESET_SPEEDS } from '../core/speed';
import {
  can,
  clearRememberedSpeeds,
  countSiteSpeeds,
  isAccessChange,
  loadAccess,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  type Access,
} from '../storage/store';
import { byId, h } from '../ui/dom';
import { icon } from '../ui/icons';

const els = {
  status: byId<HTMLSpanElement>('save-status'),
  shortcuts: byId<HTMLUListElement>('shortcuts'),
  shortcutError: byId<HTMLDivElement>('shortcut-error'),
  resetKeys: byId<HTMLButtonElement>('reset-keys'),
  step: byId<HTMLInputElement>('step'),
  stepHelp: byId<HTMLDivElement>('step-help'),
  preferred: byId<HTMLInputElement>('preferred'),
  preferredHelp: byId<HTMLDivElement>('preferred-help'),
  seek: byId<HTMLInputElement>('seek'),
  perSite: byId<HTMLInputElement>('per-site'),
  audio: byId<HTMLInputElement>('audio'),
  showController: byId<HTMLInputElement>('show-controller'),
  memorySummary: byId<HTMLDivElement>('memory-summary'),
  forget: byId<HTMLButtonElement>('forget'),
  blockForm: byId<HTMLFormElement>('block-form'),
  blockInput: byId<HTMLInputElement>('block-input'),
  blockError: byId<HTMLDivElement>('block-error'),
  blocklist: byId<HTMLUListElement>('blocklist'),
  blocklistEmpty: byId<HTMLParagraphElement>('blocklist-empty'),
  rulesLocked: byId<HTMLDivElement>('site-defaults-locked'),
  ruleForm: byId<HTMLFormElement>('rule-form'),
  ruleHost: byId<HTMLInputElement>('rule-host'),
  ruleSpeed: byId<HTMLInputElement>('rule-speed'),
  ruleAdd: byId<HTMLButtonElement>('rule-add'),
  ruleError: byId<HTMLDivElement>('rule-error'),
  rules: byId<HTMLUListElement>('rules'),
  rulesEmpty: byId<HTMLParagraphElement>('rules-empty'),
  presetsLocked: byId<HTMLDivElement>('presets-locked'),
  presetList: byId<HTMLDivElement>('preset-list'),
  presetForm: byId<HTMLFormElement>('preset-form'),
  presetInput: byId<HTMLInputElement>('preset-input'),
  presetAdd: byId<HTMLButtonElement>('preset-add'),
  presetError: byId<HTMLDivElement>('preset-error'),
  resetPresets: byId<HTMLButtonElement>('reset-presets'),
  proStatus: byId<HTMLSpanElement>('pro-status'),
  proFeatures: byId<HTMLUListElement>('pro-features'),
  proPrice: byId<HTMLSpanElement>('pro-price'),
  getPro: byId<HTMLButtonElement>('get-pro'),
  proNote: byId<HTMLParagraphElement>('pro-note'),
};

let settings: Settings = sanitizeSettings(undefined);
let access: Access = { plan: 'free', earlyAccess: EARLY_ACCESS };
let capturing: ActionId | null = null;
let statusTimer: number | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Saving -----------------------------------------------------------------------------------

async function save(patch: Partial<Settings>): Promise<boolean> {
  try {
    settings = await saveSettings(patch);
    render();
    showStatus('Saved');
    return true;
  } catch (error) {
    showStatus(`Couldn't save: ${errorMessage(error)}`, true);
    render();
    return false;
  }
}

function showStatus(text: string, isError = false): void {
  window.clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
  if (!isError) statusTimer = window.setTimeout(() => (els.status.textContent = ''), 1800);
}

// --- Rendering --------------------------------------------------------------------------------

function render(): void {
  renderShortcuts();
  if (document.activeElement !== els.step) els.step.value = String(settings.step);
  if (document.activeElement !== els.preferred) els.preferred.value = String(settings.preferredSpeed);
  if (document.activeElement !== els.seek) els.seek.value = String(settings.seekSeconds);
  const { slower, faster, preferred } = settings.keys;
  els.stepHelp.textContent = slower || faster ? `Per press of ${[slower, faster].filter(Boolean).map(keyLabel).join(' / ')}` : 'Per click of − / +';
  els.preferredHelp.textContent = preferred ? `${keyLabel(preferred)} switches between 1× and this speed` : 'Switched with 1× by its key';
  els.perSite.checked = settings.rememberPerSite;
  els.audio.checked = settings.includeAudio;
  els.showController.checked = settings.showController;
  renderBlocklist();
  renderSiteDefaults();
  renderPresets();
  renderPro();
}

// --- Pro: per-site default speeds -------------------------------------------------------------

function renderSiteDefaults(): void {
  const allowed = can(access, 'site-defaults');
  els.rulesLocked.hidden = allowed;
  for (const control of [els.ruleHost, els.ruleSpeed, els.ruleAdd]) control.disabled = !allowed;
  const focusedHost = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#rules [data-host]')?.dataset.host;
  const items = sortedSiteDefaults(settings.siteDefaults).map((rule) => {
    const speed = h('input', {
      class: 'form-control form-control-sm font-mono',
      attrs: {
        type: 'number',
        min: String(MIN_SPEED),
        max: String(MAX_SPEED),
        step: '0.05',
        inputmode: 'decimal',
        'aria-label': `Default speed for ${rule.host}`,
      },
    });
    speed.value = String(rule.speed);
    speed.disabled = !allowed;
    speed.addEventListener('change', () => {
      const value = Number(speed.value);
      if (speed.value.trim() === '' || !Number.isFinite(value)) {
        speed.value = String(rule.speed);
        return;
      }
      void save({ siteDefaults: upsertSiteDefault(settings.siteDefaults, rule.host, value) });
    });
    return h(
      'li',
      { class: 'list-group-item', attrs: { 'data-host': rule.host } },
      h('span', { class: 'rule-host', text: rule.host }),
      h('div', { class: 'input-group input-group-sm rule-speed' }, speed, h('span', { class: 'input-group-text', text: '×' })),
      h(
        'button',
        {
          class: 'btn btn-icon btn-sm',
          attrs: { type: 'button', 'data-role': 'remove', 'aria-label': `Remove the default speed for ${rule.host}`, title: 'Remove' },
          // Removing your own data is always allowed, Pro or not.
          on: { click: () => void save({ siteDefaults: removeSiteDefault(settings.siteDefaults, rule.host) }) },
        },
        icon(trash3, { size: 14 }),
      ),
    );
  });
  els.rules.replaceChildren(...items);
  els.rules.hidden = items.length === 0;
  els.rulesEmpty.hidden = items.length > 0;
  if (focusedHost) els.rules.querySelector<HTMLInputElement>(`[data-host="${CSS.escape(focusedHost)}"] input`)?.focus();
}

function showRuleError(text: string | null): void {
  els.ruleError.hidden = text === null;
  els.ruleError.textContent = text ?? '';
  els.ruleHost.classList.toggle('is-invalid', text !== null);
}

function addRule(): void {
  if (!can(access, 'site-defaults')) return;
  const raw = els.ruleHost.value;
  const host = normalizeHost(raw);
  if (!host) {
    showRuleError(raw.trim() ? `“${raw.trim()}” isn't a site name. Enter something like youtube.com.` : 'Enter a site, like youtube.com.');
    return;
  }
  const speed = els.ruleSpeed.value.trim() === '' ? Number.NaN : Number(els.ruleSpeed.value);
  if (!Number.isFinite(speed)) {
    showRuleError('Enter a speed, like 1.5.');
    return;
  }
  const exists = settings.siteDefaults.some((rule) => rule.host === host);
  const { maxSiteDefaults } = limitsFor(access.plan, access.earlyAccess);
  if (!exists && settings.siteDefaults.length >= maxSiteDefaults) {
    showRuleError(`You can keep up to ${maxSiteDefaults} sites. Remove one first.`);
    return;
  }
  showRuleError(null);
  void save({ siteDefaults: upsertSiteDefault(settings.siteDefaults, host, speed) }).then((ok) => {
    if (!ok) return;
    els.ruleHost.value = '';
    showStatus(exists ? `Updated ${host}: ${formatSpeed(clampSpeed(speed))}` : `Added ${host}: ${formatSpeed(clampSpeed(speed))}`);
  });
}

// --- Pro: custom presets ----------------------------------------------------------------------

function renderPresets(): void {
  const allowed = can(access, 'custom-presets');
  els.presetsLocked.hidden = allowed;
  for (const control of [els.presetInput, els.presetAdd, els.resetPresets]) control.disabled = !allowed;
  const shown = allowed ? settings.presets : [...PRESET_SPEEDS];
  const chips = shown.map((speed) => {
    const remove = h(
      'button',
      {
        class: 'btn btn-icon btn-sm',
        attrs: { type: 'button', 'aria-label': `Remove the ${formatSpeedShort(speed)} preset`, title: 'Remove' },
        on: { click: () => editPresets(removePreset(settings.presets, speed)) },
      },
      icon(xLg, { size: 12 }),
    );
    remove.disabled = !allowed || shown.length <= 1;
    return h('span', { class: 'preset-chip', attrs: { role: 'listitem', 'data-speed': String(speed) } }, h('span', { text: formatSpeedShort(speed) }), remove);
  });
  els.presetList.replaceChildren(...chips);
}

function showPresetError(text: string | null): void {
  els.presetError.hidden = text === null;
  els.presetError.textContent = text ?? '';
  els.presetInput.classList.toggle('is-invalid', text !== null);
}

function editPresets(result: ReturnType<typeof addPreset>): Promise<boolean> {
  if (!can(access, 'custom-presets')) return Promise.resolve(false);
  if (!result.ok) {
    showPresetError(result.error);
    return Promise.resolve(false);
  }
  showPresetError(null);
  return save({ presets: result.presets });
}

// --- About Pro --------------------------------------------------------------------------------

function renderPro(): void {
  els.proPrice.textContent = PRO_PRICE;
  els.proFeatures.replaceChildren(
    ...PRO_FEATURES.map((feature) =>
      h(
        'li',
        {},
        h('span', { class: 'pro-check' }, icon(checkLg, { size: 14 })),
        h('div', {}, h('div', { class: 'fw-semibold', text: feature.title }), h('div', { class: 'form-text mt-0', text: feature.text })),
      ),
    ),
  );
  const isPro = access.plan === 'pro';
  if (access.earlyAccess) {
    els.proStatus.textContent = 'Free during early access';
    els.proNote.textContent = 'Every Pro feature is on for everyone until payments open. Nothing to do.';
    els.getPro.hidden = false;
  } else if (isPro) {
    els.proStatus.textContent = 'Pro is active';
    els.proNote.textContent = 'Thanks for supporting Video Speed+.';
    els.getPro.hidden = true;
  } else {
    els.proStatus.textContent = 'Free plan';
    els.proNote.textContent = 'Payments are not open yet.';
    els.getPro.hidden = false;
  }
  els.getPro.disabled = true;
}

function renderShortcuts(): void {
  const rows = ACTION_IDS.map((action) => {
    const code = settings.keys[action];
    const isCapturing = capturing === action;
    const key = h('kbd', {
      class: code || isCapturing ? 'shortcut-key' : 'shortcut-key unset',
      text: isCapturing ? 'Press a key…' : keyLabel(code),
    });
    const change = h('button', {
      class: 'btn btn-choice btn-sm',
      text: isCapturing ? 'Cancel' : 'Change',
      attrs: { type: 'button', 'data-role': 'change', 'aria-label': `${isCapturing ? 'Cancel changing' : 'Change'} the key for ${ACTION_LABELS[action]}` },
      on: { click: () => (isCapturing ? stopCapture() : startCapture(action)) },
    });
    const clear = h(
      'button',
      {
        class: 'btn btn-icon btn-sm',
        attrs: { type: 'button', 'data-role': 'clear', 'aria-label': `Remove the key for ${ACTION_LABELS[action]}`, title: 'Remove key' },
        on: { click: () => void setKey(action, null) },
      },
      icon(xLg, { size: 14 }),
    );
    clear.disabled = code === null || isCapturing;
    return h(
      'li',
      { class: isCapturing ? 'list-group-item capturing' : 'list-group-item', attrs: { 'data-action': action } },
      h('span', { class: 'shortcut-name', text: ACTION_LABELS[action] }),
      key,
      change,
      clear,
    );
  });
  els.shortcuts.replaceChildren(...rows);
  if (capturing) els.shortcuts.querySelector<HTMLButtonElement>(`[data-action="${capturing}"] [data-role="change"]`)?.focus();
}

function renderBlocklist(): void {
  const items = settings.blocklist.map((host) =>
    h(
      'li',
      { class: 'list-group-item' },
      h('span', { text: host }),
      h(
        'button',
        {
          class: 'btn btn-icon btn-sm',
          attrs: { type: 'button', 'aria-label': `Remove ${host}`, title: 'Remove' },
          on: { click: () => void save({ blocklist: settings.blocklist.filter((entry) => entry !== host) }) },
        },
        icon(trash3, { size: 14 }),
      ),
    ),
  );
  els.blocklist.replaceChildren(...items);
  els.blocklist.hidden = items.length === 0;
  els.blocklistEmpty.hidden = items.length > 0;
}

async function renderMemory(): Promise<void> {
  try {
    const [sites, data] = await Promise.all([countSiteSpeeds(), chrome.storage.local.get(GLOBAL_SPEED_KEY)]);
    const global = parseGlobalSpeed(data[GLOBAL_SPEED_KEY]);
    const parts = [global === null ? 'No speed used yet' : `Last used: ${formatSpeed(global)}`];
    if (sites) parts.push(sites === 1 ? '1 site with its own speed' : `${sites} sites with their own speed`);
    els.memorySummary.textContent = parts.join(' · ');
    els.forget.disabled = global === null && sites === 0;
  } catch (error) {
    els.memorySummary.textContent = `Couldn't read remembered speeds: ${errorMessage(error)}`;
  }
}

// --- Shortcut capture -------------------------------------------------------------------------

function showShortcutError(text: string | null): void {
  els.shortcutError.hidden = text === null;
  els.shortcutError.textContent = text ?? '';
}

function startCapture(action: ActionId): void {
  capturing = action;
  showShortcutError(null);
  window.addEventListener('keydown', onCaptureKey, true);
  renderShortcuts();
}

function stopCapture(): void {
  capturing = null;
  window.removeEventListener('keydown', onCaptureKey, true);
  renderShortcuts();
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS']);

function onCaptureKey(event: KeyboardEvent): void {
  const action = capturing;
  if (!action) return;
  if (event.key === 'Tab') {
    stopCapture();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.isComposing || event.keyCode === 229 || MODIFIER_KEYS.has(event.key)) return;
  if (event.key === 'Escape') {
    stopCapture();
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
    showShortcutError('Use a single key, without Ctrl, Alt, Shift or ⌘.');
    return;
  }
  const code = eventCode(event);
  if (!isBindableCode(code)) {
    showShortcutError(`${event.key || code || 'This key'} can't be used as a shortcut.`);
    return;
  }
  const conflict = findConflict(settings.keys, action, code);
  if (conflict) {
    showShortcutError(`${keyLabel(code)} is already used for “${ACTION_LABELS[conflict]}”. Pick another key, or change that shortcut first.`);
    stopCapture();
    return;
  }
  stopCapture();
  void setKey(action, code);
}

async function setKey(action: ActionId, code: string | null): Promise<void> {
  const keys: KeyBindings = { ...settings.keys, [action]: code };
  if (await save({ keys })) showShortcutError(null);
}

// --- Setup ------------------------------------------------------------------------------------

function numberInput(input: HTMLInputElement, apply: (value: number) => Partial<Settings>, current: () => number): void {
  // `change` fires on blur/Enter; out-of-range values are clamped by sanitizeSettings and the
  // field shows the value actually saved.
  input.addEventListener('change', () => {
    const value = input.value.trim() === '' ? Number.NaN : Number(input.value);
    void save(apply(value)).then(() => {
      input.value = String(current());
    });
  });
}

async function init(): Promise<void> {
  els.step.min = String(STEP_MIN);
  els.step.max = String(STEP_MAX);
  els.preferred.min = String(MIN_SPEED);
  els.preferred.max = String(MAX_SPEED);
  els.seek.min = String(SEEK_MIN);
  els.seek.max = String(SEEK_MAX);

  [settings, access] = await Promise.all([loadSettings(), loadAccess()]);
  render();
  await renderMemory();

  els.resetKeys.addEventListener('click', () => {
    stopCapture();
    void save({ keys: { ...DEFAULT_KEYS } }).then(() => showShortcutError(null));
  });
  numberInput(els.step, (step) => ({ step }), () => settings.step);
  numberInput(els.preferred, (preferredSpeed) => ({ preferredSpeed }), () => settings.preferredSpeed);
  numberInput(els.seek, (seekSeconds) => ({ seekSeconds }), () => settings.seekSeconds);
  els.perSite.addEventListener('change', () => void save({ rememberPerSite: els.perSite.checked }));
  els.audio.addEventListener('change', () => void save({ includeAudio: els.audio.checked }));
  els.showController.addEventListener('change', () => void save({ showController: els.showController.checked }));
  els.forget.addEventListener('click', async () => {
    try {
      const sites = await clearRememberedSpeeds();
      showStatus(sites ? `Forgot speeds for ${sites} ${sites === 1 ? 'site' : 'sites'}` : 'Forgot the last speed');
    } catch (error) {
      showStatus(`Couldn't forget: ${errorMessage(error)}`, true);
    }
    await renderMemory();
  });

  els.blockForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = els.blockInput.value;
    const host = normalizeHost(raw);
    if (!host) {
      showBlockError(raw.trim() ? `“${raw.trim()}” isn't a site name. Enter something like example.com.` : 'Enter a site, like example.com.');
      return;
    }
    if (settings.blocklist.includes(host)) {
      showBlockError(`${host} is already on the list.`);
      return;
    }
    showBlockError(null);
    void save({ blocklist: [...settings.blocklist, host] }).then((ok) => {
      if (ok) els.blockInput.value = '';
    });
  });
  els.blockInput.addEventListener('input', () => showBlockError(null));

  els.ruleForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addRule();
  });
  els.ruleHost.addEventListener('input', () => showRuleError(null));
  els.presetForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = els.presetInput.value.trim() === '' ? Number.NaN : Number(els.presetInput.value);
    void editPresets(addPreset(settings.presets, value)).then((ok) => {
      if (ok) els.presetInput.value = '';
    });
  });
  els.presetInput.addEventListener('input', () => showPresetError(null));
  els.resetPresets.addEventListener('click', () => {
    showPresetError(null);
    void save({ presets: [...PRESET_SPEEDS] });
  });

  // Changes made elsewhere (the popup's site switch, another settings tab, remembered speeds).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SETTINGS_KEY]) {
      settings = sanitizeSettings(changes[SETTINGS_KEY].newValue);
      if (!capturing) render();
    }
    if (Object.keys(changes).some((key) => key.startsWith('speed:'))) void renderMemory();
    if (isAccessChange(changes)) {
      void loadAccess().then((next) => {
        access = next;
        if (!capturing) render();
      });
    }
  });
}

function showBlockError(text: string | null): void {
  els.blockError.hidden = text === null;
  els.blockError.textContent = text ?? '';
  els.blockInput.classList.toggle('is-invalid', text !== null);
}

init().catch((error: unknown) => showStatus(`Couldn't load settings: ${errorMessage(error)}`, true));
