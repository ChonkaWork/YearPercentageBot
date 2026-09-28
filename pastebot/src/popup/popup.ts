import { orderForDisplay, searchHistory, type HistoryItem } from '../core/history';
import { hasFeature, isHistoryAtFreeLimit, limitMessage, type ProFeature } from '../core/plan';
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
  loadPlanState,
  loadSettings,
  loadTemplates,
  saveSettings,
  setHistoryPinned,
  takePendingSelection,
  updateHistoryPrompt,
  type PlanState,
} from '../storage/store';
import { ACTIONS, actionLabel } from '../templates';
import { copyFromDocument } from '../ui/clipboard';
import { h } from '../ui/dom';
import { icon, mountIcons } from '../ui/icons';
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
  contextToggle: byId<HTMLDivElement>('context-toggle'),
  includeContext: byId<HTMLInputElement>('include-context'),
  error: byId<HTMLDivElement>('error'),
  errorText: byId<HTMLSpanElement>('error-text'),
  trim: byId<HTMLButtonElement>('trim'),
  result: byId<HTMLElement>('result'),
  output: byId<HTMLTextAreaElement>('output'),
  outputCount: byId<HTMLSpanElement>('output-count'),
  copyStatus: byId<HTMLSpanElement>('copy-status'),
  copy: byId<HTMLButtonElement>('copy'),
  historyList: byId<HTMLDivElement>('history-list'),
  historyEmpty: byId<HTMLParagraphElement>('history-empty'),
  historyEmptyText: byId<HTMLSpanElement>('history-empty-text'),
  clearHistory: byId<HTMLButtonElement>('clear-history'),
  historyCount: byId<HTMLSpanElement>('history-count'),
  searchBox: byId<HTMLDivElement>('history-search-box'),
  search: byId<HTMLInputElement>('history-search'),
  noMatch: byId<HTMLParagraphElement>('history-no-match'),
  noMatchText: byId<HTMLSpanElement>('history-no-match-text'),
  limit: byId<HTMLParagraphElement>('history-limit'),
  limitText: byId<HTMLSpanElement>('history-limit-text'),
  aboutPro: byId<HTMLAnchorElement>('about-pro'),
};

const TEMPLATE_VALUE = 'template:';

let source: PageContext | null = null;
let historyEnabled = true;
let currentHistoryId: string | null = null;
let generatedPrompt = '';
let statusTimer: number | undefined;
let clearConfirmTimer: number | undefined;
let planState: PlanState | null = null;
let historyItems: HistoryItem[] = [];

function pro(feature: ProFeature): boolean {
  return planState ? hasFeature(planState.plan, feature, planState.earlyAccess) : false;
}

// --- Setup ------------------------------------------------------------------------------

async function init(): Promise<void> {
  mountIcons();
  for (const action of ACTIONS) {
    els.action.append(h('option', { text: action.id === 'custom' ? 'Custom…' : action.label, attrs: { value: action.id } }));
  }

  const [settings, lastInstruction, plan, templates] = await Promise.all([
    loadSettings(),
    loadLastInstruction(),
    loadPlanState(),
    loadTemplates(),
  ]);
  planState = plan;
  if (pro('templates') && templates.length > 0) {
    const group = h('optgroup', { attrs: { label: 'Your templates (Pro)' } });
    for (const template of templates) {
      group.append(h('option', { text: template.name, attrs: { value: `${TEMPLATE_VALUE}${template.id}` } }));
    }
    els.action.append(group);
  }
  els.search.disabled = !pro('history-search');
  if (els.search.disabled) {
    els.search.placeholder = 'Search history';
    els.searchBox.title = limitMessage('history-search');
  }
  els.action.value = settings.defaultAction;
  els.includeContext.checked = settings.includePageContext;
  els.instruction.value = lastInstruction;
  historyEnabled = settings.maxHistoryItems > 0;

  const pending = await takePendingSelection();
  if (pending) {
    setInput(pending.text, pending.page);
    if (pending.action) els.action.value = pending.action;
    if (pending.templateId && hasOption(`${TEMPLATE_VALUE}${pending.templateId}`)) {
      els.action.value = `${TEMPLATE_VALUE}${pending.templateId}`;
    }
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
  if (selectedTemplateId() !== null) return 'custom';
  return isPromptAction(els.action.value) ? els.action.value : 'analyze';
}

function selectedTemplateId(): string | null {
  return els.action.value.startsWith(TEMPLATE_VALUE) ? els.action.value.slice(TEMPLATE_VALUE.length) : null;
}

function hasOption(value: string): boolean {
  return [...els.action.options].some((option) => option.value === value);
}

function syncActionUi(): void {
  els.instruction.hidden = els.action.value !== 'custom';
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
  const templateId = selectedTemplateId();
  if (templateId !== null) request.templateId = templateId;
  else if (action === 'custom') request.customInstruction = els.instruction.value;

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
    if (templateId === null && (response.code === 'EMPTY_INSTRUCTION' || response.code === 'INSTRUCTION_TOO_LONG')) els.instruction.focus();
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
  els.copyStatus.classList.toggle('text-danger', isError);
  els.copyStatus.classList.toggle('text-success', !isError);
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
    els.historyEmptyText.textContent = "Couldn't load history.";
    els.historyEmpty.hidden = false;
    return;
  }
  historyItems = items;
  renderHistoryList();
}

/** Renders the loaded history with the current search (synchronous, so typing stays in order). */
function renderHistoryList(): void {
  const items = historyItems;
  const query = els.search.disabled ? '' : els.search.value.trim();
  const shown = orderForDisplay(searchHistory(items, query));
  els.historyList.replaceChildren(...shown.map(renderHistoryItem));
  els.historyEmpty.hidden = items.length > 0;
  els.historyEmptyText.textContent = historyEnabled ? 'Prompts you make show up here.' : 'History is turned off in settings.';
  els.noMatch.hidden = items.length === 0 || shown.length > 0;
  els.noMatchText.textContent = `No prompts match “${query}”.`;
  els.historyCount.textContent = items.length > 0 ? (query ? `· ${shown.length} of ${items.length}` : `· ${items.length}`) : '';
  els.searchBox.hidden = items.length === 0;
  const hasPinned = items.some((item) => item.pinned);
  els.clearHistory.hidden = items.length === 0 || items.every((item) => item.pinned);
  els.clearHistory.dataset.label = hasPinned ? 'Clear unpinned' : 'Clear all';
  if (!els.clearHistory.dataset.confirm) els.clearHistory.textContent = els.clearHistory.dataset.label;

  // Calm note once a free history is full; nothing is blocked or deleted.
  const atLimit = planState !== null && historyEnabled && isHistoryAtFreeLimit(items.length, planState.limits);
  els.limit.hidden = !atLimit;
  els.limitText.textContent = limitMessage('history');
}

function renderHistoryItem(item: HistoryItem): HTMLDivElement {
  const title = item.pageTitle ?? item.preview ?? firstLine(item.prompt);
  const detail = item.pageTitle && item.preview ? item.preview : hostOf(item.pageUrl);
  const sub = [relativeTime(item.timestamp), detail].filter(Boolean).join(' · ');

  const copyButton = h(
    'button',
    { class: 'btn btn-icon', attrs: { type: 'button', 'aria-label': 'Copy prompt', title: 'Copy prompt' } },
    icon('clipboard'),
  );
  copyButton.addEventListener('click', async () => {
    const copied = await copyPrompt(item.prompt);
    if (!copied) showResult(item.prompt, item.id);
    copyButton.replaceChildren(icon(copied ? 'clipboardCheck' : 'exclamationTriangleFill'));
    window.setTimeout(() => copyButton.replaceChildren(icon('clipboard')), 1200);
  });

  const deleteButton = h(
    'button',
    { class: 'btn btn-icon', attrs: { type: 'button', 'aria-label': 'Delete prompt', title: 'Delete' } },
    icon('trash3'),
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

  const canPin = pro('pinned-history');
  const pinButton =
    canPin || item.pinned
      ? h(
          'button',
          {
            class: item.pinned ? 'btn btn-icon pin active' : 'btn btn-icon pin',
            attrs: {
              type: 'button',
              'aria-label': item.pinned ? 'Unpin prompt' : 'Pin prompt',
              'aria-pressed': String(Boolean(item.pinned)),
              title: item.pinned ? 'Unpin' : 'Pin to keep it on top',
            },
          },
          icon(item.pinned ? 'pinAngleFill' : 'pinAngle'),
        )
      : null;
  pinButton?.addEventListener('click', async () => {
    try {
      await setHistoryPinned(item.id, !item.pinned);
      await renderHistory();
    } catch {
      setStatus("Couldn't update this item.", true);
    }
  });

  const main = h(
    'button',
    {
      class: 'history-main flex-grow-1',
      attrs: { type: 'button', title: item.pageUrl ? `${title}\n${item.pageUrl}` : title },
      on: {
        click: () => {
          showResult(item.prompt, item.id);
          els.output.focus();
        },
      },
    },
    h('span', {
      class: item.templateName ? 'badge rounded-pill template-badge' : 'badge rounded-pill bg-primary-subtle text-primary-emphasis',
      text: item.templateName ?? actionLabel(item.action),
    }),
    h('span', { class: 'history-title', text: title }),
    h('span', { class: 'history-sub', text: sub }),
  );

  return h(
    'div',
    {
      class: item.pinned ? 'list-group-item history-item pinned d-flex align-items-center gap-1 pe-2' : 'list-group-item history-item d-flex align-items-center gap-1 pe-2',
      attrs: { 'data-id': item.id },
    },
    main,
    pinButton,
    copyButton,
    deleteButton,
  );
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
  els.clearHistory.textContent = els.clearHistory.dataset.label ?? 'Clear all';
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
els.search.addEventListener('input', renderHistoryList);
els.aboutPro.addEventListener('click', (event) => {
  event.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#pro') });
});
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
