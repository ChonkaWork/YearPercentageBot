import type { Destination } from '../core/destinations';
import { orderForDisplay, searchHistory, type HistoryItem } from '../core/history';
import { askVariables, MAX_VARIABLE_VALUE_CHARS, missingVariables } from '../core/variables';
import { hasFeature, isHistoryAtFreeLimit, limitMessage, type ProFeature } from '../core/plan';
import { MAX_INPUT_CHARS, truncateToLimit } from '../core/limits';
import { prepareContent } from '../core/clean';
import { MASK_CATEGORY_INFO, maskSecrets, type MaskedItem, type MaskOptions } from '../core/mask';
import { sanitizePageContext } from '../core/pageContext';
import { maskOptionsOf } from '../core/settings';
import { resolveTargetLanguage } from '../core/languages';
import { isDirectAction, type PageContext, type PromptAction } from '../core/types';
import type { MakePromptRequest, MakePromptResponse, OpenRequest, TemplateRef } from '../platform/messages';
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
import { maskReview } from '../ui/maskReview';
import { splitCopy, type SplitCopy } from '../ui/splitCopy';
import { copyShortcutLabel, formatCount, relativeTime } from '../ui/format';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

const els = {
  openOptions: byId<HTMLButtonElement>('open-options'),
  tabCompose: byId<HTMLButtonElement>('tab-compose'),
  tabHistory: byId<HTMLButtonElement>('tab-history'),
  historyTabCount: byId<HTMLSpanElement>('history-tab-count'),
  panelCompose: byId<HTMLElement>('panel-compose'),
  panelHistory: byId<HTMLElement>('panel-history'),
  sourceRow: byId<HTMLDivElement>('source-row'),
  sourceTitle: byId<HTMLSpanElement>('source-title'),
  inputBlock: byId<HTMLDivElement>('input-block'),
  input: byId<HTMLTextAreaElement>('input'),
  inputCount: byId<HTMLSpanElement>('input-count'),
  clearInput: byId<HTMLButtonElement>('clear-input'),
  inputSummary: byId<HTMLButtonElement>('input-summary'),
  inputSummaryText: byId<HTMLSpanElement>('input-summary-text'),
  maskNote: byId<HTMLParagraphElement>('mask-note'),
  maskNoteText: byId<HTMLSpanElement>('mask-note-text'),
  contextToggle: byId<HTMLButtonElement>('context-toggle'),
  actions: byId<HTMLDivElement>('actions'),
  templatesBlock: byId<HTMLDivElement>('templates-block'),
  templateChips: byId<HTMLDivElement>('template-chips'),
  instructionRow: byId<HTMLDivElement>('instruction-row'),
  instruction: byId<HTMLInputElement>('instruction'),
  make: byId<HTMLButtonElement>('make'),
  variablesForm: byId<HTMLFormElement>('variables-form'),
  variablesTitle: byId<HTMLSpanElement>('variables-title'),
  variablesFields: byId<HTMLDivElement>('variables-fields'),
  error: byId<HTMLDivElement>('error'),
  errorText: byId<HTMLSpanElement>('error-text'),
  trim: byId<HTMLButtonElement>('trim'),
  result: byId<HTMLElement>('result'),
  output: byId<HTMLTextAreaElement>('output'),
  outputCount: byId<HTMLSpanElement>('output-count'),
  maskReviewSlot: byId<HTMLDivElement>('mask-review-slot'),
  splitSlot: byId<HTMLDivElement>('split-slot'),
  copyStatus: byId<HTMLParagraphElement>('copy-status'),
  historyList: byId<HTMLDivElement>('history-list'),
  historyEmpty: byId<HTMLParagraphElement>('history-empty'),
  historyEmptyText: byId<HTMLSpanElement>('history-empty-text'),
  clearHistory: byId<HTMLButtonElement>('clear-history'),
  historyCount: byId<HTMLSpanElement>('history-count'),
  historyStatus: byId<HTMLParagraphElement>('history-status'),
  searchBox: byId<HTMLDivElement>('history-search-box'),
  search: byId<HTMLInputElement>('history-search'),
  noMatch: byId<HTMLParagraphElement>('history-no-match'),
  noMatchText: byId<HTMLSpanElement>('history-no-match-text'),
  limit: byId<HTMLParagraphElement>('history-limit'),
  limitText: byId<HTMLSpanElement>('history-limit-text'),
  aboutPro: byId<HTMLAnchorElement>('about-pro'),
};

/** The chip that runs: a built-in action or one of the user's templates. */
type Selected = { action: PromptAction } | { template: TemplateRef };

/** Masking state of the prompt in the result box. */
interface MaskState {
  items: MaskedItem[];
  /** Set after "Undo masking": the masked prompt, for "Mask again". */
  maskedPrompt?: string;
  reviewOpen: boolean;
  /** How to make it again without masking. */
  request: MakePromptRequest | null;
}

let source: PageContext | null = null;
let includePageContext = false;
let historyEnabled = true;
let currentHistoryId: string | null = null;
let generatedPrompt = '';
let statusTimer: number | undefined;
let clearConfirmTimer: number | undefined;
let noteTimer: number | undefined;
let planState: PlanState | null = null;
let historyItems: HistoryItem[] = [];
let templates: TemplateRef[] = [];
let selected: Selected = { action: 'analyze' };
let maskOptions: MaskOptions | null = null;
let maskState: MaskState = { items: [], reviewOpen: false, request: null };
let openIn: Destination = 'chatgpt';
let split: SplitCopy | null = null;
const chips = new Map<string, HTMLButtonElement>();

function pro(feature: ProFeature): boolean {
  return planState ? hasFeature(planState.plan, feature, planState.earlyAccess) : false;
}

// --- Setup ------------------------------------------------------------------------------

async function init(): Promise<void> {
  mountIcons();
  const [settings, lastInstruction, plan, storedTemplates] = await Promise.all([
    loadSettings(),
    loadLastInstruction(),
    loadPlanState(),
    loadTemplates(),
  ]);
  planState = plan;
  maskOptions = maskOptionsOf(settings);
  openIn = settings.openIn;
  const withVariables = pro('template-variables');
  templates = pro('templates')
    ? storedTemplates.map(({ id, name, instruction }) => ({ id, name, asks: withVariables ? askVariables(instruction) : [] }))
    : [];
  renderChips(resolveTargetLanguage(settings.translateTo, uiLanguage()).name);
  select({ action: settings.defaultAction });

  els.search.disabled = !pro('history-search');
  if (els.search.disabled) {
    els.search.placeholder = 'Search history';
    els.searchBox.title = limitMessage('history-search');
  }
  includePageContext = settings.includePageContext;
  els.instruction.value = lastInstruction;
  historyEnabled = settings.maxHistoryItems > 0;
  split = splitCopy({
    destination: openIn,
    onCopy: () => void copyEdited(),
    onOpen: (destination) => void copyAndOpen(destination),
    onChoose: (destination) => {
      openIn = destination;
      saveSettings({ openIn: destination }).catch(() => setStatus("Couldn't save this preference.", true));
    },
  });
  els.splitSlot.replaceChildren(split.element);
  const copyButton = split.element.querySelector<HTMLButtonElement>('[data-copy]');
  if (copyButton) copyButton.id = 'copy';

  const pending = await takePendingSelection();
  if (pending) {
    setInput(pending.text, pending.page);
    if (pending.action && isDirectAction(pending.action)) select({ action: pending.action });
    const template = pending.templateId ? templates.find((candidate) => candidate.id === pending.templateId) : undefined;
    if (template) select({ template });
    if (pending.message) showError(pending.message);
  } else {
    await prefillFromSelection();
  }
  void clearBadge();

  updateContextToggle();
  updateInputCount();
  await renderHistory();
  (els.input.value.trim() ? (chips.get(chipKey(selected)) ?? els.input) : els.input).focus();
}

function uiLanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return 'en';
  }
}

/** The same numbered chips as the in-page panel: 1-7 the actions, 8 Custom, 9 the first template. */
function renderChips(translateTo: string): void {
  chips.clear();
  els.actions.replaceChildren(
    ...ACTIONS.map((action, index) => {
      const label = action.id === 'custom' ? 'Custom…' : action.label;
      const title = action.id === 'translate' ? `Translate to ${translateTo} (change it in settings)` : action.description;
      const chip = h(
        'button',
        { class: 'chip', attrs: { type: 'button', 'data-action': action.id, title, 'aria-pressed': 'false' } },
        h('kbd', { text: String(index + 1) }),
        h('span', { class: 'chip-label', text: label }),
      );
      chip.addEventListener('click', () => onChip({ action: action.id }));
      chips.set(action.id, chip);
      return chip;
    }),
  );
  els.templatesBlock.hidden = templates.length === 0;
  els.templateChips.replaceChildren(
    ...templates.map((template, index) => {
      const asks = template.asks.length > 0;
      const chip = h(
        'button',
        {
          class: 'chip template',
          attrs: {
            type: 'button',
            'data-template-id': template.id,
            'aria-pressed': 'false',
            title: asks ? `${template.name} (asks for ${template.asks.map((ask) => ask.name).join(', ')})` : template.name,
          },
        },
        index === 0 ? h('kbd', { text: String(ACTIONS.length + 1) }) : icon('bookmark'),
        h('span', { class: 'chip-label', text: asks ? `${template.name}…` : template.name }),
      );
      chip.addEventListener('click', () => onChip({ template }));
      chips.set(`template:${template.id}`, chip);
      return chip;
    }),
  );
}

function chipKey(choice: Selected): string {
  return 'action' in choice ? choice.action : `template:${choice.template.id}`;
}

function select(choice: Selected): void {
  selected = choice;
  const key = chipKey(choice);
  for (const [chipId, chip] of chips) chip.setAttribute('aria-pressed', String(chipId === key));
  els.instructionRow.hidden = !('action' in choice && choice.action === 'custom');
  const asks = 'template' in choice ? choice.template.asks : [];
  els.variablesForm.hidden = asks.length === 0;
  if ('template' in choice && asks.length > 0) renderVariables(choice.template);
}

/** A chip was clicked (or its number pressed): Custom and templates with variables ask first. */
function onChip(choice: Selected): void {
  const again = chipKey(choice) === chipKey(selected);
  select(choice);
  if ('action' in choice && choice.action === 'custom') {
    els.instruction.focus();
    if (again && els.instruction.value.trim()) void make();
  } else if ('template' in choice && choice.template.asks.length > 0) {
    els.variablesFields.querySelector<HTMLInputElement>('input')?.focus();
  } else {
    void make();
  }
}

function renderVariables(template: TemplateRef): void {
  els.variablesTitle.textContent = `“${template.name}” asks for`;
  els.variablesFields.replaceChildren(
    ...template.asks.flatMap((ask, index) => {
      const input = h('input', {
        class: 'form-control form-control-sm',
        attrs: {
          id: `variable-${index}`,
          type: 'text',
          maxlength: String(MAX_VARIABLE_VALUE_CHARS),
          autocomplete: 'off',
          'data-variable': ask.name,
          ...(ask.defaultValue ? { placeholder: ask.defaultValue } : {}),
        },
      });
      input.value = ask.defaultValue;
      return [h('label', { class: 'form-label small fw-semibold mb-0', text: ask.name, attrs: { for: input.id } }), input];
    }),
  );
}

function variableValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of els.variablesFields.querySelectorAll<HTMLInputElement>('input[data-variable]')) {
    values[input.dataset.variable ?? ''] = input.value;
  }
  return values;
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
  els.sourceRow.hidden = !page?.title && !page?.url;
  els.sourceTitle.textContent = page?.title ?? page?.url ?? '';
  els.sourceTitle.title = page?.url ?? '';
  expandInput(false);
  updateContextToggle();
  updateInputCount();
}

// --- Tabs -------------------------------------------------------------------------------

function showTab(name: 'compose' | 'history', focus = false): void {
  const compose = name === 'compose';
  els.panelCompose.hidden = !compose;
  els.panelHistory.hidden = compose;
  els.tabCompose.setAttribute('aria-selected', String(compose));
  els.tabHistory.setAttribute('aria-selected', String(!compose));
  els.tabCompose.tabIndex = compose ? 0 : -1;
  els.tabHistory.tabIndex = compose ? -1 : 0;
  if (focus) (compose ? els.tabCompose : els.tabHistory).focus();
}

// --- Compose ----------------------------------------------------------------------------

/** After a prompt is made the text collapses to one line, so the prompt and Copy stay in view. */
function collapseInput(): void {
  if (!els.input.value.trim()) return;
  const flat = els.input.value.slice(0, 200).replace(/\s+/g, ' ').trim();
  els.inputSummaryText.textContent = `“${flat.length > 64 ? `${flat.slice(0, 63).trimEnd()}…` : flat}” · ${formatCount(els.input.value.length)} chars`;
  els.inputBlock.hidden = true;
  els.inputSummary.hidden = false;
  els.maskNote.hidden = true;
}

function expandInput(focus = true): void {
  els.inputBlock.hidden = false;
  els.inputSummary.hidden = true;
  updateMaskNote();
  if (focus) els.input.focus();
}

/** Shown next to "From <page>": without a page there is no title or URL to add. */
function updateContextToggle(): void {
  const available = source !== null;
  els.contextToggle.disabled = !available;
  els.contextToggle.hidden = !available;
  els.contextToggle.setAttribute('aria-pressed', String(available && includePageContext));
  els.contextToggle.title = available ? 'Add the page title and URL to the prompt' : 'Available for text selected on a page';
}

function updateInputCount(): void {
  const length = els.input.value.length;
  els.inputCount.textContent = `${formatCount(length)} / ${formatCount(MAX_INPUT_CHARS)}`;
  els.inputCount.classList.toggle('over', length > MAX_INPUT_CHARS);
  els.clearInput.hidden = length === 0;
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(updateMaskNote, 120);
}

/** "Masks 3 items: …" under the text, before anything is made (same cleanup as the generator). */
function updateMaskNote(): void {
  const text = els.input.value;
  const items = maskOptions && !els.inputBlock.hidden && text.trim() && text.length <= MAX_INPUT_CHARS ? maskSecrets(prepareContent(text).text, maskOptions).items : [];
  els.maskNote.hidden = items.length === 0;
  const kinds = [...new Set(items.map((item) => MASK_CATEGORY_INFO[item.category].noun))];
  els.maskNoteText.textContent = `${items.length === 1 ? 'Masks 1 item' : `Masks ${items.length} items`}: ${kinds.join(', ')}`;
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

function buildRequest(): MakePromptRequest | string {
  const request: MakePromptRequest = {
    type: 'pastebot/make',
    action: 'action' in selected ? selected.action : 'custom',
    text: els.input.value,
    includePageContext: includePageContext && source !== null,
    page: source,
    // Copy from this (focused) document instead of the background.
    copy: false,
  };
  if ('template' in selected) {
    request.templateId = selected.template.id;
    if (selected.template.asks.length > 0) {
      const values = variableValues();
      const missing = missingVariables(selected.template.asks, values);
      if (missing.length > 0) return `Fill in ${missing.join(', ')}.`;
      request.variables = values;
    }
  } else if (selected.action === 'custom') {
    request.customInstruction = els.instruction.value;
  }
  return request;
}

async function send(request: MakePromptRequest): Promise<MakePromptResponse | undefined> {
  try {
    return (await chrome.runtime.sendMessage(request)) as MakePromptResponse | undefined;
  } catch {
    return undefined;
  }
}

async function make(): Promise<void> {
  hideError();
  const request = buildRequest();
  if (typeof request === 'string') {
    showError(request);
    els.variablesFields.querySelector<HTMLInputElement>('input')?.focus();
    return;
  }

  setBusy(true);
  const response = await send(request);
  setBusy(false);

  if (!response) {
    showError('Pastebot could not make the prompt. Please try again.');
    return;
  }
  if (!response.ok) {
    showError(response.message, response.code === 'TEXT_TOO_LARGE');
    if (request.templateId === undefined && (response.code === 'EMPTY_INSTRUCTION' || response.code === 'INSTRUCTION_TOO_LONG')) els.instruction.focus();
    else if (response.code === 'EMPTY_TEXT' || response.code === 'TEXT_TOO_LARGE') expandInput();
    return;
  }

  maskState = { items: response.masked, reviewOpen: false, request };
  showResult(response.prompt, response.historyId);
  collapseInput();
  const copied = await copyPrompt(response.prompt);
  if (copied && !response.historySaved) setStatus("Copied! (Couldn't save to history)");
  await renderHistory();
}

function setBusy(busy: boolean): void {
  els.make.disabled = busy;
  for (const chip of chips.values()) chip.disabled = busy;
  els.panelCompose.setAttribute('aria-busy', String(busy));
}

// --- Result -----------------------------------------------------------------------------

function showResult(prompt: string, historyId: string | null): void {
  generatedPrompt = prompt;
  currentHistoryId = historyId;
  els.output.value = prompt;
  els.result.hidden = false;
  updateOutputCount();
  renderMaskReview();
  els.output.scrollTop = 0;
  els.result.scrollIntoView({ block: 'nearest' });
}

function renderMaskReview(): void {
  const review = maskReview({
    items: maskState.items,
    undone: maskState.maskedPrompt !== undefined,
    open: maskState.reviewOpen,
    onToggle: (open) => {
      maskState.reviewOpen = open;
      renderMaskReview();
      els.maskReviewSlot.querySelector<HTMLButtonElement>('.mask-toggle')?.focus();
    },
    onUndo: () => void undoMasking(),
    onRedo: () => void maskAgain(),
  });
  els.maskReviewSlot.replaceChildren(...(review ? [review] : []));
}

/** Makes the same prompt without masking. It is copied, never saved: history keeps the masked one. */
async function undoMasking(): Promise<void> {
  if (!maskState.request) return;
  const response = await send({ ...maskState.request, unmasked: true });
  if (!response?.ok) {
    setStatus("Couldn't undo the masking. The masked prompt is still copied.", true);
    return;
  }
  const masked = els.output.value;
  maskState = { ...maskState, maskedPrompt: masked };
  generatedPrompt = response.prompt;
  // Edits to an unmasked prompt must not reach history.
  currentHistoryId = null;
  els.output.value = response.prompt;
  updateOutputCount();
  renderMaskReview();
  if (await copyPrompt(response.prompt)) setStatus('Copied without masking.');
}

async function maskAgain(): Promise<void> {
  if (maskState.maskedPrompt === undefined) return;
  const prompt = maskState.maskedPrompt;
  maskState = { items: maskState.items, reviewOpen: false, request: maskState.request };
  generatedPrompt = prompt;
  currentHistoryId = null;
  els.output.value = prompt;
  updateOutputCount();
  renderMaskReview();
  if (await copyPrompt(prompt)) setStatus('Masked prompt copied.');
}

function updateOutputCount(): void {
  els.outputCount.textContent = `${formatCount(els.output.value.length)} chars`;
  split?.setPrompt(els.output.value);
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
    showTab('compose');
    els.result.hidden = false;
    els.output.focus();
    els.output.select();
  }
  return copied;
}

/** The status line of the visible tab. */
function setStatus(text: string, isError = false): void {
  window.clearTimeout(statusTimer);
  const target = els.panelHistory.hidden ? els.copyStatus : els.historyStatus;
  for (const status of [els.copyStatus, els.historyStatus]) status.textContent = status === target ? text : '';
  target.classList.toggle('text-danger', isError);
  target.classList.toggle('text-success', !isError);
  if (!isError) statusTimer = window.setTimeout(() => (target.textContent = ''), 2500);
}

async function copyEdited(): Promise<boolean> {
  const text = els.output.value;
  if (!text.trim()) return false;
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
  return copied;
}

/** Copy & open: copied here (a user gesture), then the background opens the tab. */
async function copyAndOpen(destination: Destination): Promise<void> {
  const text = els.output.value;
  if (!text.trim()) return;
  await copyEdited();
  const request: OpenRequest = { type: 'pastebot/open', destination, prompt: text, copy: false };
  try {
    await chrome.runtime.sendMessage(request);
  } catch {
    setStatus("Couldn't open the tab. The prompt is copied.", true);
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
  els.historyTabCount.textContent = items.length > 0 ? String(items.length) : '';
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
          // Reopen it in Compose, ready to edit, copy or open in an AI.
          maskState = { items: [], reviewOpen: false, request: null };
          showTab('compose');
          collapseInput();
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

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

// --- Events -----------------------------------------------------------------------------

els.openOptions.addEventListener('click', () => void chrome.runtime.openOptionsPage());
els.tabCompose.addEventListener('click', () => showTab('compose'));
els.tabHistory.addEventListener('click', () => showTab('history'));
for (const tab of [els.tabCompose, els.tabHistory]) {
  tab.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      showTab(els.panelCompose.hidden ? 'compose' : 'history', true);
    }
  });
}
els.input.addEventListener('input', () => {
  updateInputCount();
  if (!els.error.hidden && els.input.value.length <= MAX_INPUT_CHARS) hideError();
});
els.clearInput.addEventListener('click', () => {
  setInput('', null);
  hideError();
  els.input.focus();
});
els.inputSummary.addEventListener('click', () => expandInput());
els.contextToggle.addEventListener('click', () => {
  includePageContext = !includePageContext;
  updateContextToggle();
  saveSettings({ includePageContext }).catch(() => showError("Couldn't save this preference."));
});
els.make.addEventListener('click', () => void make());
els.variablesForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void make();
});
els.trim.addEventListener('click', () => {
  els.input.value = truncateToLimit(els.input.value, MAX_INPUT_CHARS);
  updateInputCount();
  hideError();
  (chips.get(chipKey(selected)) ?? els.input).focus();
});
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
    showTab('compose');
    void make();
  } else if (event.key === 'Enter' && event.target === els.instruction) {
    event.preventDefault();
    void make();
  } else if (/^[1-9]$/.test(event.key) && !isTyping(event.target) && !els.panelCompose.hidden && !event.ctrlKey && !event.metaKey && !event.altKey) {
    // Same numbers as the panel: 1-7 actions, 8 Custom, 9 the first template.
    const index = Number(event.key) - 1;
    const choice: Selected | null =
      index < ACTIONS.length ? { action: ACTIONS[index]?.id ?? 'analyze' } : templates[0] ? { template: templates[0] } : null;
    if (choice) {
      event.preventDefault();
      chips.get(chipKey(choice))?.focus();
      onChip(choice);
    }
  }
});

init().catch(() => showError('Pastebot failed to start. Try reopening the popup.'));
