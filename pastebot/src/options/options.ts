import { MAX_HISTORY_LIMIT, type Settings } from '../core/settings';
import { isDirectAction, isPromptStyle } from '../core/types';
import { loadSettings, saveSettings } from '../storage/store';
import { ACTIONS } from '../templates';
import { h } from '../ui/dom';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

const els = {
  includePageContext: byId<HTMLInputElement>('include-page-context'),
  defaultAction: byId<HTMLSelectElement>('default-action'),
  maxHistory: byId<HTMLInputElement>('max-history'),
  status: byId<HTMLSpanElement>('save-status'),
  shortcut: byId<HTMLElement>('shortcut'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
};
const styleInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="prompt-style"]')];
let statusTimer: number | undefined;

function render(settings: Settings): void {
  els.includePageContext.checked = settings.includePageContext;
  els.defaultAction.value = settings.defaultAction;
  els.maxHistory.value = String(settings.maxHistoryItems);
  for (const input of styleInputs) input.checked = input.value === settings.promptStyle;
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
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
  if (!isError) statusTimer = window.setTimeout(() => (els.status.textContent = ''), 1800);
}

async function renderShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((command) => command.name === 'make-prompt')?.shortcut;
    els.shortcut.textContent = shortcut || 'Not set';
  } catch {
    els.shortcut.textContent = 'Unavailable';
  }
}

async function init(): Promise<void> {
  for (const action of ACTIONS) {
    if (isDirectAction(action.id)) els.defaultAction.append(h('option', { text: action.label, attrs: { value: action.id } }));
  }
  els.maxHistory.max = String(MAX_HISTORY_LIMIT);
  render(await loadSettings());
  await renderShortcut();

  els.includePageContext.addEventListener('change', () => void save({ includePageContext: els.includePageContext.checked }));
  els.defaultAction.addEventListener('change', () => {
    if (isDirectAction(els.defaultAction.value)) void save({ defaultAction: els.defaultAction.value });
  });
  for (const input of styleInputs) {
    input.addEventListener('change', () => {
      if (input.checked && isPromptStyle(input.value)) void save({ promptStyle: input.value });
    });
  }
  // `change` fires on blur/enter; invalid values are clamped by sanitizeSettings.
  els.maxHistory.addEventListener('change', () => void save({ maxHistoryItems: Number(els.maxHistory.value) }));
  els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  // Shortcuts can change on chrome://extensions/shortcuts while this page is open.
  window.addEventListener('focus', () => void renderShortcut());
}

init().catch(() => showStatus("Couldn't load settings.", true));
