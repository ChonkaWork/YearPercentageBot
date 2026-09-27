import checkIcon from 'bootstrap-icons/icons/check2.svg';
import errorIcon from 'bootstrap-icons/icons/exclamation-circle-fill.svg';
import { toMarkdown } from '../core/markdown';
import { BULLET_MARKERS, CSV_DELIMITERS, EMPHASIS_MARKERS, SHORTCUT_FORMATS, type Settings } from '../core/settings';
import { el } from '../core/snapshot';
import { loadSettings, saveSettings } from '../storage/store';
import { byId } from '../ui/dom';
import { svgIcon } from '../ui/icons';

const COMMAND = 'copy-selection';

const els = {
  shortcut: byId<HTMLElement>('shortcut'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  includeLinkUrls: byId<HTMLInputElement>('include-link-urls'),
  markdownSample: byId<HTMLDivElement>('markdown-sample'),
  status: byId<HTMLSpanElement>('save-status'),
};

const radios = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`)];
const groups = {
  shortcutFormat: radios('shortcut-format'),
  bulletMarker: radios('bullet'),
  emphasisMarker: radios('emphasis'),
  csvDelimiter: radios('csv-delimiter'),
};

let statusTimer: number | undefined;

const SAMPLE = [
  el('ul', null, el('li', null, 'A list with ', el('em', null, 'italic'), ' text'), el('li', null, el('strong', null, 'Bold'), ' and ', el('code', null, 'code'))),
];

function render(settings: Settings): void {
  for (const input of groups.shortcutFormat) input.checked = input.value === settings.shortcutFormat;
  for (const input of groups.bulletMarker) input.checked = input.value === settings.bulletMarker;
  for (const input of groups.emphasisMarker) input.checked = input.value === settings.emphasisMarker;
  for (const input of groups.csvDelimiter) input.checked = input.value === settings.csvDelimiter;
  els.includeLinkUrls.checked = settings.includeLinkUrls;
  els.markdownSample.textContent = toMarkdown(SAMPLE, { bullet: settings.bulletMarker, emphasis: settings.emphasisMarker });
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

function onRadio<K extends keyof typeof groups>(key: K, allowed: readonly string[]): void {
  for (const input of groups[key]) {
    input.addEventListener('change', () => {
      if (input.checked && allowed.includes(input.value)) void save({ [key]: input.value } as Partial<Settings>);
    });
  }
}

async function init(): Promise<void> {
  render(await loadSettings());
  await renderShortcut();
  onRadio('shortcutFormat', SHORTCUT_FORMATS);
  onRadio('bulletMarker', BULLET_MARKERS);
  onRadio('emphasisMarker', EMPHASIS_MARKERS);
  onRadio('csvDelimiter', CSV_DELIMITERS);
  els.includeLinkUrls.addEventListener('change', () => void save({ includeLinkUrls: els.includeLinkUrls.checked }));
  els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  // Shortcuts can change on chrome://extensions/shortcuts while this page is open.
  window.addEventListener('focus', () => void renderShortcut());
}

init().catch(() => showStatus("Couldn't load settings.", true));
