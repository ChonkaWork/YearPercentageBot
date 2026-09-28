import checkIcon from 'bootstrap-icons/icons/check2.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import { EARLY_ACCESS, FEATURE_DESCRIPTIONS, FEATURE_LABELS, hasFeature, PRO_FEATURES, PRO_PRICE } from '../core/plan';
import { CSV_DELIMITERS, type Settings } from '../core/settings';
import { loadPlan, loadSettings, saveSettings } from '../storage/store';
import { byId, h } from '../ui/dom';
import { svgIcon } from '../ui/icons';

const COMMAND = '_execute_action';

const els = {
  shortcut: byId<HTMLElement>('shortcut'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  xlsxNumbers: byId<HTMLInputElement>('xlsx-numbers'),
  keepLinks: byId<HTMLInputElement>('keep-links'),
  status: byId<HTMLSpanElement>('save-status'),
  proPrice: byId<HTMLSpanElement>('pro-price'),
  proFeatures: byId<HTMLUListElement>('pro-features'),
  getPro: byId<HTMLButtonElement>('get-pro'),
  proStatus: byId<HTMLSpanElement>('pro-status'),
};

const csvRadios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="csv-delimiter"]')];

let statusTimer: number | undefined;

function render(settings: Settings): void {
  for (const input of csvRadios) input.checked = input.value === settings.csvDelimiter;
  els.xlsxNumbers.checked = settings.xlsxNumbers;
  els.keepLinks.checked = settings.keepLinks;
}

async function save(patch: Partial<Settings>): Promise<void> {
  try {
    render(await saveSettings(patch));
    showStatus('Saved');
  } catch {
    showStatus("Couldn't save. Please try again.", true);
  }
}

function showStatus(text: string, isError = false): void {
  window.clearTimeout(statusTimer);
  els.status.className = `save-status ms-auto small fw-semibold d-inline-flex align-items-center gap-1 ${isError ? 'text-danger' : 'text-success'}`;
  els.status.replaceChildren(svgIcon(isError ? errorIcon : checkIcon, 16), text);
  if (!isError) statusTimer = window.setTimeout(() => els.status.replaceChildren(), 1800);
}

async function renderShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    els.shortcut.textContent = commands.find((command) => command.name === COMMAND)?.shortcut || 'Not set';
  } catch {
    els.shortcut.textContent = 'Unavailable';
  }
}

async function renderPro(): Promise<void> {
  const plan = await loadPlan();
  els.proPrice.textContent = `${PRO_PRICE} one-time`;
  els.proFeatures.replaceChildren(
    ...PRO_FEATURES.map((feature) =>
      h(
        'li',
        { class: 'd-flex gap-2 mb-2' },
        svgIcon(checkIcon, 16),
        h('div', {}, h('div', { class: 'fw-bold', text: FEATURE_LABELS[feature] }), h('div', { class: 'small text-body-secondary', text: FEATURE_DESCRIPTIONS[feature] })),
      ),
    ),
  );
  // Payments aren't set up yet: while EARLY_ACCESS is on, everyone has Pro.
  els.getPro.disabled = true;
  if (EARLY_ACCESS) els.proStatus.textContent = 'Free during early access: every Pro feature is on.';
  else if (PRO_FEATURES.every((feature) => hasFeature(plan, feature))) els.proStatus.textContent = 'Pro is active. Thank you!';
  else els.proStatus.textContent = 'Coming soon.';
}

async function init(): Promise<void> {
  render(await loadSettings());
  await Promise.all([renderShortcut(), renderPro()]);
  for (const input of csvRadios) {
    input.addEventListener('change', () => {
      if (input.checked && (CSV_DELIMITERS as readonly string[]).includes(input.value)) void save({ csvDelimiter: input.value as Settings['csvDelimiter'] });
    });
  }
  els.xlsxNumbers.addEventListener('change', () => void save({ xlsxNumbers: els.xlsxNumbers.checked }));
  els.keepLinks.addEventListener('change', () => void save({ keepLinks: els.keepLinks.checked }));
  els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  // Shortcuts can change on chrome://extensions/shortcuts while this page is open.
  window.addEventListener('focus', () => void renderShortcut());
  if (location.hash === '#pro') document.getElementById('pro')?.focus();
}

init().catch(() => showStatus("Couldn't load settings.", true));
