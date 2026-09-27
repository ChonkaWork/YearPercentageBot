import type { HistoryItem } from '../core/history';
import { MAX_INPUT_CHARS, truncateToLimit } from '../core/limits';
import { sanitizePageContext } from '../core/pageContext';
import { isPromptAction, type PageContext, type PromptAction } from '../core/types';
import type { MakePromptRequest, MakePromptResponse } from '../platform/messages';
import { captureSelection } from '../platform/selection';
import {
  clearHistory,
  deleteHistoryItem,
  loadHistory,
  loadLastInstruction,
  loadSettings,
  saveSettings,
  takePendingSelection,
  updateHistoryPrompt,
} from '../storage/store';
import { ACTIONS, actionLabel } from '../templates';
import { copyFromDocument } from '../ui/clipboard';
import { h, icon, ICONS } from '../ui/dom';
import { copyShortcutLabel, formatCount, relativeTime } from '../ui/format';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  source: byId<HTMLDivElement>('source'),
  sourceTitle: byId<HTMLSpanElement>('source-title'),
  input: byId<HTMLTextAreaElement>('input'),
  inputCount: byId<HTMLSpanElement>('input-count'),
  clearInput: byId<HTMLButtonElement>('clear-input'),
  action: byId<HTMLSelectElement>('action'),
  make: byId<HTMLButtonElement>('make'),
  instruction: byId<HTMLInputElement>('instruction'),
  contextToggle: byId<HTMLLabelElement>('context-toggle'),
  includeContext: byId<HTMLInputElement>('include-context'),
  error: byId<HTMLDivElement>('error'),
  errorText: byId<HTMLSpanElement>('error-text'),
  trim: byId<HTMLButtonElement>('trim'),
  result: byId<HTMLElement>('result'),
  output: byId<HTMLTextAreaElement>('output'),
  outputCount: byId<HTMLSpanElement>('output-count'),
  copyStatus: byId<HTMLSpanElement>('copy-status'),
  copy: byId<HTMLButtonElement>('copy'),
  historyList: byId<HTMLUListElement>('history-list'),
  historyEmpty: byId<HTMLParagraphElement>('history-empty'),
  clearHistory: byId<HTMLButtonElement>('clear-history'),
};

let source: PageContext | null = null;
let historyEnabled = true;
let currentHistoryId: string | null = null;
let generatedPrompt = '';
let statusTimer: number | undefined;
let clearConfirmTimer: number | undefined;

// --- Setup ------------------------------------------------------------------------------

async function init(): Promise<void> {
  els.openOptions.append(icon(ICONS.settings, { size: 16 }));
  for (const action of ACTIONS) {
    els.action.append(h('option', { text: action.id === 'custom' ? 'Custom…' : action.label, attrs: { value: action.id } }));
  }

  const [settings, lastInstruction] = await Promise.all([loadSettings(), loadLastInstruction()]);
  els.action.value = settings.defaultAction;
  els.includeContext.checked = settings.includePageContext;
  els.instruction.value = lastInstruction;
  historyEnabled = settings.maxHistoryItems > 0;

  const pending = await takePendingSelection();
  if (pending) {
    setInput(pending.text, pending.page);
    if (pending.action) els.action.value = pending.action;
    if (pending.message) showError(pending.message);
  } else {
    await prefillFromSelection();
  }
  void clearBadge();

  syncActionUi();
  updateInputCount();
  await renderHistory();
  (els.input.value.trim() ? els.make : els.input).focus();
}

/** When the popup opens over a page with selected text, start from that text. */
async function prefillFromSelection(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    const selection = await captureSelection(tab.id, 0);
    if (!selection?.text.trim()) return;
    setInput(selection.text, sanitizePageContext({ title: tab.title || selection.title, url: tab.url || selection.url }));
    if (selection.totalLength > selection.text.length) {
      showError(`Only the first ${formatCount(selection.text.length)} characters of the selection were read.`);
    }
  } catch {
    // Pages the extension can't read (chrome://, Web Store...): start empty.
  }
}

async function clearBadge(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.action.setBadgeText(tab?.id !== undefined ? { tabId: tab.id, text: '' } : { text: '' });
  } catch {
    // Nothing to clear.
  }
}

function setInput(text: string, page: PageContext | null): void {
  els.input.value = text;
  source = page;
  els.source.hidden = !page?.title && !page?.url;
  els.sourceTitle.textContent = page?.title ?? page?.url ?? '';
  els.sourceTitle.title = page?.url ?? '';
  updateContextToggle();
  updateInputCount();
}

// --- Compose ----------------------------------------------------------------------------

function selectedAction(): PromptAction {
  return isPromptAction(els.action.value) ? els.action.value : 'analyze';
}

function syncActionUi(): void {
  els.instruction.hidden = selectedAction() !== 'custom';
}

function updateContextToggle(): void {
  const available = source !== null;
  els.includeContext.disabled = !available;
  els.contextToggle.classList.toggle('disabled', !available);
  els.contextToggle.title = available ? 'Adds the page title and URL to the prompt' : 'Available for text selected on a page';
}

function updateInputCount(): void {
  const length = els.input.value.length;
  els.inputCount.textContent = `${formatCount(length)} / ${formatCount(MAX_INPUT_CHARS)}`;
  els.inputCount.classList.toggle('over', length > MAX_INPUT_CHARS);
  els.clearInput.hidden = length === 0;
}

function showError(message: string, offerTrim = false): void {
  els.errorText.textContent = message;
  els.trim.hidden = !offerTrim;
  els.trim.textContent = `Keep the first ${formatCount(MAX_INPUT_CHARS)} characters`;
  els.error.hidden = false;
}

function hideError(): void {
  els.error.hidden = true;
}

async function make(): Promise<void> {
  hideError();
  const action = selectedAction();
  const request: MakePromptRequest = {
    type: 'pastebot/make',
    action,
    text: els.input.value,
    includePageContext: els.includeContext.checked && source !== null,
    page: source,
    // Copy from this (focused) document instead of the background.
    copy: false,
  };
  if (action === 'custom') request.customInstruction = els.instruction.value;

  els.make.disabled = true;
  let response: MakePromptResponse | undefined;
  try {
    response = (await chrome.runtime.sendMessage(request)) as MakePromptResponse | undefined;
  } catch {
    response = undefined;
  } finally {
    els.make.disabled = false;
  }

  if (!response) {
    showError('Pastebot could not make the prompt. Please try again.');
    return;
  }
  if (!response.ok) {
    showError(response.message, response.code === 'TEXT_TOO_LARGE');
    if (response.code === 'EMPTY_INSTRUCTION' || response.code === 'INSTRUCTION_TOO_LONG') els.instruction.focus();
    else if (response.code === 'EMPTY_TEXT') els.input.focus();
    return;
  }

  showResult(response.prompt, response.historyId);
  const copied = await copyPrompt(response.prompt);
  if (copied && !response.historySaved) setStatus("Copied! (Couldn't save to history)");
  await renderHistory();
}

// --- Result -----------------------------------------------------------------------------

function showResult(prompt: string, historyId: string | null): void {
  generatedPrompt = prompt;
  currentHistoryId = historyId;
  els.output.value = prompt;
  els.result.hidden = false;
  updateOutputCount();
  els.output.scrollTop = 0;
}

function updateOutputCount(): void {
  els.outputCount.textContent = `${formatCount(els.output.value.length)} chars`;
}

async function copyPrompt(text: string): Promise<boolean> {
  let copied = await copyFromDocument(text);
  if (!copied) {
    try {
      const response = (await chrome.runtime.sendMessage({ type: 'pastebot/copy', text })) as { ok?: boolean } | undefined;
      copied = response?.ok === true;
    } catch {
      copied = false;
    }
  }
  if (copied) {
    setStatus('Copied!');
  } else {
    setStatus(`Couldn't copy. Press ${copyShortcutLabel()} to copy the selected prompt.`, true);
    els.result.hidden = false;
    els.output.focus();
    els.output.select();
  }
  return copied;
}

function setStatus(text: string, isError = false): void {
  window.clearTimeout(statusTimer);
  els.copyStatus.textContent = text;
  els.copyStatus.classList.toggle('error', isError);
  if (!isError) statusTimer = window.setTimeout(() => (els.copyStatus.textContent = ''), 2500);
}

async function copyEdited(): Promise<void> {
  const text = els.output.value;
  if (!text.trim()) return;
  const copied = await copyPrompt(text);
  if (copied && currentHistoryId && text !== generatedPrompt) {
    try {
      await updateHistoryPrompt(currentHistoryId, text);
      generatedPrompt = text;
      await renderHistory();
    } catch {
      setStatus("Copied! (Couldn't update history)");
    }
  }
}

// --- History ----------------------------------------------------------------------------

async function renderHistory(): Promise<void> {
  let items: HistoryItem[];
  try {
    items = await loadHistory();
  } catch {
    els.historyList.replaceChildren();
    els.historyEmpty.textContent = "Couldn't load history.";
    els.historyEmpty.hidden = false;
    return;
  }
  els.historyList.replaceChildren(...items.map(renderHistoryItem));
  els.historyEmpty.hidden = items.length > 0;
  els.historyEmpty.textContent = historyEnabled ? 'Prompts you make show up here.' : 'History is turned off in settings.';
  els.clearHistory.hidden = items.length === 0;
}

function renderHistoryItem(item: HistoryItem): HTMLLIElement {
  const title = item.pageTitle ?? item.preview ?? firstLine(item.prompt);
  const detail = item.pageTitle && item.preview ? item.preview : hostOf(item.pageUrl);
  const sub = [relativeTime(item.timestamp), detail].filter(Boolean).join(' · ');

  const copyButton = h(
    'button',
    { class: 'icon-button', attrs: { type: 'button', 'aria-label': 'Copy prompt', title: 'Copy prompt' } },
    icon(ICONS.copy, { size: 15 }),
  );
  copyButton.addEventListener('click', async () => {
    const copied = await copyPrompt(item.prompt);
    if (!copied) showResult(item.prompt, item.id);
    copyButton.replaceChildren(icon(copied ? ICONS.check : ICONS.alert, { size: 15 }));
    window.setTimeout(() => copyButton.replaceChildren(icon(ICONS.copy, { size: 15 })), 1200);
  });

  const deleteButton = h(
    'button',
    { class: 'icon-button', attrs: { type: 'button', 'aria-label': 'Delete prompt', title: 'Delete' } },
    icon(ICONS.trash, { size: 15 }),
  );
  deleteButton.addEventListener('click', async () => {
    try {
      await deleteHistoryItem(item.id);
      if (currentHistoryId === item.id) currentHistoryId = null;
      await renderHistory();
    } catch {
      setStatus("Couldn't delete this item.", true);
    }
  });

  const main = h(
    'button',
    {
      class: 'history-main',
      attrs: { type: 'button', title: item.pageUrl ? `${title}\n${item.pageUrl}` : title },
      on: {
        click: () => {
          showResult(item.prompt, item.id);
          els.output.focus();
        },
      },
    },
    h('span', { class: 'tag', text: actionLabel(item.action) }),
    h('span', { class: 'history-title', text: title }),
    h('span', { class: 'history-sub', text: sub }),
  );

  return h('li', { class: 'history-item' }, main, copyButton, deleteButton);
}

async function onClearHistory(): Promise<void> {
  if (!els.clearHistory.dataset.confirm) {
    els.clearHistory.dataset.confirm = '1';
    els.clearHistory.textContent = 'Click again to clear';
    clearConfirmTimer = window.setTimeout(resetClearButton, 3000);
    return;
  }
  resetClearButton();
  try {
    await clearHistory();
    currentHistoryId = null;
    await renderHistory();
  } catch {
    setStatus("Couldn't clear history.", true);
  }
}

function resetClearButton(): void {
  window.clearTimeout(clearConfirmTimer);
  delete els.clearHistory.dataset.confirm;
  els.clearHistory.textContent = 'Clear all';
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// --- Events -----------------------------------------------------------------------------

els.openOptions.addEventListener('click', () => void chrome.runtime.openOptionsPage());
els.input.addEventListener('input', () => {
  updateInputCount();
  if (!els.error.hidden && els.input.value.length <= MAX_INPUT_CHARS) hideError();
});
els.clearInput.addEventListener('click', () => {
  setInput('', null);
  hideError();
  els.input.focus();
});
els.action.addEventListener('change', () => {
  syncActionUi();
  if (selectedAction() === 'custom') els.instruction.focus();
});
els.includeContext.addEventListener('change', () => {
  saveSettings({ includePageContext: els.includeContext.checked }).catch(() => showError("Couldn't save this preference."));
});
els.make.addEventListener('click', () => void make());
els.trim.addEventListener('click', () => {
  els.input.value = truncateToLimit(els.input.value, MAX_INPUT_CHARS);
  updateInputCount();
  hideError();
  els.make.focus();
});
els.copy.addEventListener('click', () => void copyEdited());
els.output.addEventListener('input', updateOutputCount);
els.clearHistory.addEventListener('click', () => void onClearHistory());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void make();
  } else if (event.key === 'Enter' && event.target === els.instruction) {
    event.preventDefault();
    void make();
  }
});

init().catch(() => showError('Pastebot failed to start. Try reopening the popup.'));
