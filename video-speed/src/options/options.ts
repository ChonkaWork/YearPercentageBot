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
import { sanitizeSettings, SEEK_MAX, SEEK_MIN, STEP_MAX, STEP_MIN, type Settings } from '../core/settings';
import { formatSpeed, MAX_SPEED, MIN_SPEED } from '../core/speed';
import { clearRememberedSpeeds, countSiteSpeeds, loadSettings, saveSettings, SETTINGS_KEY } from '../storage/store';
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
};

let settings: Settings = sanitizeSettings(undefined);
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

  settings = await loadSettings();
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

  // Changes made elsewhere (the popup's site switch, another settings tab, remembered speeds).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SETTINGS_KEY]) {
      settings = sanitizeSettings(changes[SETTINGS_KEY].newValue);
      if (!capturing) render();
    }
    if (Object.keys(changes).some((key) => key.startsWith('speed:'))) void renderMemory();
  });
}

function showBlockError(text: string | null): void {
  els.blockError.hidden = text === null;
  els.blockError.textContent = text ?? '';
  els.blockInput.classList.toggle('is-invalid', text !== null);
}

init().catch((error: unknown) => showStatus(`Couldn't load settings: ${errorMessage(error)}`, true));
