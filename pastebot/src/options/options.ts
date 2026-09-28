import {
  exportTemplates,
  importSummary,
  importTemplates,
  moveTemplate,
  removeTemplate,
  upsertTemplate,
  validateTemplate,
  type CustomTemplate,
} from '../core/customTemplates';
import { generatePrompt } from '../core/generate';
import { TRANSLATE_LANGUAGES, languageForLocale } from '../core/languages';
import { MASK_CATEGORIES, MASK_CATEGORY_INFO, isMaskCategory, maskSecrets, maskSummary, type MaskCategory } from '../core/mask';
import { EARLY_ACCESS, PRO_FEATURES, PRO_PRICE, hasFeature, limitMessage, type ProFeature } from '../core/plan';
import { maskOptionsOf, type Settings } from '../core/settings';
import { isDirectAction, isPromptStyle, type PromptStyle } from '../core/types';
import { VARIABLE_CHIPS, askVariables, isoDate } from '../core/variables';
import { loadPlanState, loadSettings, loadTemplates, saveSettings, saveTemplates, type PlanState } from '../storage/store';
import { ACTIONS } from '../templates';
import { h } from '../ui/dom';
import { icon, mountIcons } from '../ui/icons';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

const els = {
  includePageContext: byId<HTMLInputElement>('include-page-context'),
  defaultAction: byId<HTMLSelectElement>('default-action'),
  translateTo: byId<HTMLSelectElement>('translate-to'),
  // Masking
  maskSecrets: byId<HTMLInputElement>('mask-secrets'),
  maskCategories: byId<HTMLFieldSetElement>('mask-categories'),
  maskTryInput: byId<HTMLTextAreaElement>('mask-try-input'),
  maskTryOutput: byId<HTMLPreElement>('mask-try-output'),
  maskTrySummary: byId<HTMLParagraphElement>('mask-try-summary'),
  maxHistory: byId<HTMLInputElement>('max-history'),
  maxHistoryLimit: byId<HTMLSpanElement>('max-history-limit'),
  historyLimit: byId<HTMLParagraphElement>('history-limit'),
  historyLimitText: byId<HTMLSpanElement>('history-limit-text'),
  status: byId<HTMLSpanElement>('save-status'),
  shortcut: byId<HTMLElement>('shortcut'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  // Custom templates
  addTemplate: byId<HTMLButtonElement>('add-template'),
  importTemplates: byId<HTMLButtonElement>('import-templates'),
  exportTemplates: byId<HTMLButtonElement>('export-templates'),
  importFile: byId<HTMLInputElement>('import-file'),
  importStatus: byId<HTMLDivElement>('import-status'),
  variableChips: byId<HTMLDivElement>('variable-chips'),
  templateAsks: byId<HTMLParagraphElement>('template-asks'),
  templatesLocked: byId<HTMLParagraphElement>('templates-locked'),
  templatesLockedText: byId<HTMLSpanElement>('templates-locked-text'),
  editor: byId<HTMLFormElement>('template-editor'),
  editorTitle: byId<HTMLHeadingElement>('template-editor-title'),
  templateName: byId<HTMLInputElement>('template-name'),
  templateNameError: byId<HTMLDivElement>('template-name-error'),
  templateInstruction: byId<HTMLTextAreaElement>('template-instruction'),
  templateInstructionError: byId<HTMLDivElement>('template-instruction-error'),
  templatePreview: byId<HTMLPreElement>('template-preview'),
  cancelTemplate: byId<HTMLButtonElement>('cancel-template'),
  templateList: byId<HTMLDivElement>('template-list'),
  templatesEmpty: byId<HTMLParagraphElement>('templates-empty'),
  // About Pro
  proStatus: byId<HTMLParagraphElement>('pro-status'),
  proPrice: byId<HTMLDivElement>('pro-price'),
  proFeatures: byId<HTMLUListElement>('pro-features'),
  getPro: byId<HTMLButtonElement>('get-pro'),
};
const styleInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="prompt-style"]')];
const SAMPLE_TEXT = 'Q3 revenue grew 18% to $4.2M, driven by the EU launch. Churn rose to 3.1%.';
const SAMPLE_PAGE = { title: 'Q3 results · Acme Blog', url: 'https://blog.example.com/q3-results' };
/** Fake values for "Try it" (the AWS key is Amazon's documented example). */
const MASK_SAMPLE = [
  '2026-09-27 14:03:12 ERROR charge failed for anna.kowalski@example.com',
  '  card=4242 4242 4242 4242 amount=129.00 EUR ip=203.0.113.42',
  '  aws_access_key_id=AKIAIOSFODNN7EXAMPLE password=hunter2',
  '    at /Users/anna/shop/server.js:120',
].join('\n');

let statusTimer: number | undefined;
let planState: PlanState | null = null;
let templates: CustomTemplate[] = [];
/** Id of the template being edited; null for a new one. */
let editingId: string | null = null;
let promptStyle: PromptStyle = 'balanced';
let settingsNow: Settings | null = null;

function pro(feature: ProFeature): boolean {
  return planState ? hasFeature(planState.plan, feature, planState.earlyAccess) : false;
}

// --- Settings ---------------------------------------------------------------------------

function render(settings: Settings): void {
  settingsNow = settings;
  els.includePageContext.checked = settings.includePageContext;
  els.defaultAction.value = settings.defaultAction;
  els.translateTo.value = settings.translateTo;
  els.maxHistory.value = String(Math.min(settings.maxHistoryItems, historyMax()));
  for (const input of styleInputs) input.checked = input.value === settings.promptStyle;
  promptStyle = settings.promptStyle;
  els.maskSecrets.checked = settings.maskSecrets;
  for (const input of els.maskCategories.querySelectorAll<HTMLInputElement>('input[data-mask-category]')) {
    input.checked = !settings.maskOff.includes(input.value as MaskCategory);
    input.disabled = !settings.maskSecrets;
  }
  els.maskCategories.classList.toggle('off', !settings.maskSecrets);
  updateMaskTry();
}

// --- Masking ----------------------------------------------------------------------------

function renderMaskCategories(): void {
  els.maskCategories.append(
    ...MASK_CATEGORIES.map((category) => {
      const info = MASK_CATEGORY_INFO[category];
      const input = h('input', {
        class: 'form-check-input',
        attrs: { type: 'checkbox', value: category, id: `mask-${category}`, 'data-mask-category': category },
      });
      input.addEventListener('change', () => {
        const off = [...els.maskCategories.querySelectorAll<HTMLInputElement>('input[data-mask-category]')]
          .filter((box) => !box.checked)
          .map((box) => box.value)
          .filter(isMaskCategory);
        void save({ maskOff: off });
      });
      return h(
        'div',
        { class: 'form-check mask-category' },
        input,
        h(
          'label',
          { class: 'form-check-label', attrs: { for: input.id } },
          h('span', { class: 'fw-semibold d-block', text: info.label }),
          h('span', { class: 'd-block small text-body-secondary font-mono example', text: info.example }),
        ),
      );
    }),
  );
}

/** Runs the real masker on the "Try it" text with the current settings. */
function updateMaskTry(): void {
  const text = els.maskTryInput.value;
  const options = settingsNow ? maskOptionsOf(settingsNow) : { off: [] };
  if (!options) {
    els.maskTryOutput.textContent = text;
    els.maskTrySummary.textContent = 'Masking is off: prompts keep these values.';
    return;
  }
  const result = maskSecrets(text, options);
  els.maskTryOutput.textContent = result.text || ' ';
  els.maskTrySummary.textContent = result.items.length ? `${maskSummary(result.items)}.` : 'Nothing to mask in this text.';
}

function historyMax(): number {
  return planState?.limits.maxHistoryItems ?? 0;
}

async function save(patch: Partial<Settings>): Promise<void> {
  try {
    render(await saveSettings(patch));
    showStatus('Saved');
  } catch {
    showStatus("Couldn't save. Please try again.", true);
  }
}

/** The plan caps the history size; asking for more saves the cap and explains, calmly. */
function saveHistorySize(): void {
  const requested = Number(els.maxHistory.value);
  const overLimit = Number.isFinite(requested) && requested > historyMax() && !pro('long-history');
  els.historyLimit.hidden = !overLimit;
  void save({ maxHistoryItems: Number.isFinite(requested) ? Math.min(requested, historyMax()) : requested });
}

function showStatus(text: string, isError = false): void {
  window.clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle('text-danger', isError);
  els.status.classList.toggle('text-success', !isError);
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

// --- Custom templates -------------------------------------------------------------------

function renderTemplates(): void {
  const canCreate = (planState?.limits.maxTemplates ?? 0) > templates.length;
  els.addTemplate.disabled = !canCreate || !els.editor.hidden;
  els.importTemplates.disabled = !pro('template-sharing') || !els.editor.hidden;
  els.importTemplates.title = pro('template-sharing') ? 'Add templates from a JSON file' : limitMessage('template-sharing');
  // Your own templates can always be exported, whatever the plan.
  els.exportTemplates.disabled = templates.length === 0;
  const locked = !pro('templates');
  els.templatesLocked.hidden = !locked;
  els.templatesLockedText.textContent = limitMessage('templates');
  els.templatesEmpty.hidden = templates.length > 0 || !els.editor.hidden;
  els.templateList.replaceChildren(...templates.map(renderTemplateItem));
}

function renderTemplateItem(template: CustomTemplate, index: number): HTMLElement {
  const button = (label: string, name: Parameters<typeof icon>[0], onClick: () => void, disabled = false) => {
    const element = h(
      'button',
      { class: 'btn btn-icon', attrs: { type: 'button', 'aria-label': `${label}: ${template.name}`, title: label }, on: { click: onClick } },
      icon(name),
    );
    element.disabled = disabled;
    return element;
  };
  const deleteButton = button('Delete', 'trash3', () => {
    if (!deleteButton.dataset.confirm) {
      deleteButton.dataset.confirm = '1';
      deleteButton.classList.add('confirm');
      deleteButton.replaceChildren(h('span', { class: 'small fw-semibold', text: 'Delete?' }));
      window.setTimeout(() => {
        if (!deleteButton.isConnected) return;
        delete deleteButton.dataset.confirm;
        deleteButton.classList.remove('confirm');
        deleteButton.replaceChildren(icon('trash3'));
      }, 3000);
      return;
    }
    void commitTemplates(removeTemplate(templates, template.id), 'Template deleted');
  });

  return h(
    'div',
    { class: 'list-group-item template-item d-flex align-items-center gap-2', attrs: { 'data-id': template.id } },
    h(
      'div',
      { class: 'flex-grow-1 min-w-0' },
      h('div', { class: 'fw-semibold text-truncate template-name', text: template.name }),
      h('div', { class: 'template-instruction text-truncate', text: template.instruction.replace(/\s+/g, ' ') }),
    ),
    button('Move up', 'chevronUp', () => void commitTemplates(moveTemplate(templates, template.id, -1)), index === 0),
    button('Move down', 'chevronDown', () => void commitTemplates(moveTemplate(templates, template.id, 1)), index === templates.length - 1),
    button('Edit', 'pencil', () => openEditor(template)),
    deleteButton,
  );
}

async function commitTemplates(next: CustomTemplate[], message = 'Saved'): Promise<boolean> {
  try {
    templates = await saveTemplates(next);
    renderTemplates();
    showStatus(message);
    return true;
  } catch {
    showStatus("Couldn't save. Please try again.", true);
    return false;
  }
}

function openEditor(template: CustomTemplate | null): void {
  els.importStatus.hidden = true;
  editingId = template?.id ?? null;
  els.editorTitle.textContent = template ? 'Edit template' : 'New template';
  els.templateName.value = template?.name ?? '';
  els.templateInstruction.value = template?.instruction ?? '';
  showFieldErrors(null);
  els.editor.hidden = false;
  renderTemplates();
  updatePreview();
  els.templateName.focus();
}

function closeEditor(): void {
  els.editor.hidden = true;
  editingId = null;
  renderTemplates();
  els.addTemplate.focus();
}

function showFieldErrors(error: { field: 'name' | 'instruction'; message: string } | null): void {
  els.templateNameError.textContent = error?.field === 'name' ? error.message : '';
  els.templateInstructionError.textContent = error?.field === 'instruction' ? error.message : '';
  els.templateName.classList.toggle('is-invalid', error?.field === 'name');
  els.templateInstruction.classList.toggle('is-invalid', error?.field === 'instruction');
}

async function submitTemplate(): Promise<void> {
  const result = validateTemplate(
    { name: els.templateName.value, instruction: els.templateInstruction.value },
    templates,
    editingId ?? undefined,
  );
  if (!result.ok) {
    showFieldErrors(result);
    (result.field === 'name' ? els.templateName : els.templateInstruction).focus();
    return;
  }
  const template: CustomTemplate = { id: editingId ?? crypto.randomUUID(), ...result.value };
  if (await commitTemplates(upsertTemplate(templates, template), editingId ? 'Template saved' : 'Template added')) closeEditor();
}

/**
 * Runs the real generator on sample text and a sample page, so the preview is exactly what gets
 * copied. Asked variables show their default, or [Name] where the answer will go.
 */
function updatePreview(): void {
  const instruction = els.templateInstruction.value.trim();
  const asks = askVariables(instruction);
  els.templateAsks.hidden = asks.length === 0;
  els.templateAsks.textContent = `Asks when you run it: ${asks.map((ask) => (ask.defaultValue ? `${ask.name} (default “${ask.defaultValue}”)` : ask.name)).join(', ')}.`;
  if (!instruction) {
    els.templatePreview.textContent = 'Write an instruction to see the prompt.';
    els.templatePreview.classList.add('placeholder-text');
    return;
  }
  const values = Object.fromEntries(asks.map((ask) => [ask.name, ask.defaultValue || `[${ask.name}]`]));
  const result = generatePrompt({
    action: 'custom',
    selectedText: SAMPLE_TEXT,
    style: promptStyle,
    customInstruction: instruction,
    variables: pro('template-variables') ? { page: SAMPLE_PAGE, date: isoDate(), values } : null,
  });
  els.templatePreview.classList.toggle('placeholder-text', !result.ok);
  els.templatePreview.textContent = result.ok ? result.prompt : result.message;
}

/** Variable chips above the instruction: insert at the cursor; {{Variable}} selects the name to type over. */
function renderVariableChips(): void {
  for (const token of VARIABLE_CHIPS) {
    const chip = h('button', {
      class: 'variable-chip',
      text: token,
      attrs: { type: 'button', 'data-insert': token, title: chipTitle(token) },
      on: { click: () => insertToken(token) },
    });
    els.variableChips.append(chip);
  }
}

function chipTitle(token: string): string {
  switch (token) {
    case '{content}':
      return 'Where the selected text goes (at most once)';
    case '{title}':
      return 'The page title';
    case '{url}':
      return 'The page address (tracking and secret parameters removed)';
    case '{date}':
      return "Today's date (YYYY-MM-DD)";
    default:
      return 'Asked for when you run the template. Add a default like {{Language=English}}';
  }
}

function insertToken(token: string): void {
  const field = els.templateInstruction;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(token, start, end, 'end');
  if (token.startsWith('{{')) {
    // Select "Variable" so the user types the name right away.
    field.setSelectionRange(start + 2, start + token.length - 2);
  }
  field.focus();
  updatePreview();
  if (field.classList.contains('is-invalid')) showFieldErrors(null);
}

// --- Import and export (Pro) ------------------------------------------------------------

function exportAll(): void {
  if (templates.length === 0) return;
  const blob = new Blob([exportTemplates(templates)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { attrs: { href: url, download: `pastebot-templates-${isoDate()}.json` } });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showStatus(`Exported ${templates.length} ${templates.length === 1 ? 'template' : 'templates'}`);
}

async function importFromFile(file: File): Promise<void> {
  if (!pro('template-sharing')) return;
  let text: string;
  try {
    text = file.size > 1_000_000 ? '' : await file.text();
  } catch {
    text = '';
  }
  const result = text
    ? importTemplates(templates, text, () => crypto.randomUUID(), planState?.limits.maxTemplates)
    : { ok: false as const, message: "Couldn't read this file. Pick a JSON file exported by Pastebot." };
  if (!result.ok) {
    showImportStatus(result.message, true);
    return;
  }
  if (result.added + result.updated === 0 || (await commitTemplates(result.templates, 'Templates imported'))) {
    showImportStatus(importSummary(result), false);
  }
}

function showImportStatus(message: string, isError: boolean): void {
  els.importStatus.textContent = message;
  els.importStatus.classList.toggle('alert-danger', isError);
  els.importStatus.classList.toggle('alert-success', !isError);
  els.importStatus.hidden = false;
}

// --- About Pro --------------------------------------------------------------------------

function renderAboutPro(): void {
  els.proPrice.textContent = PRO_PRICE;
  els.proFeatures.replaceChildren(
    ...PRO_FEATURES.map((item) =>
      h(
        'li',
        { class: 'd-flex gap-2' },
        icon('checkCircleFill'),
        h('span', {}, h('span', { class: 'fw-semibold', text: item.title }), h('span', { class: 'd-block small text-body-secondary', text: item.description })),
      ),
    ),
  );
  const early = planState?.earlyAccess ?? EARLY_ACCESS;
  const hasPro = planState?.plan === 'pro';
  // Payments aren't set up yet, so the button is disabled in every state for now.
  els.getPro.disabled = true;
  els.getPro.setAttribute('aria-label', 'Get Pro');
  if (early) {
    els.getPro.textContent = 'Free during early access';
    els.proStatus.textContent = `Free during early access: every Pro feature is on for everyone. Later, Pro will be a one-time ${PRO_PRICE}.`;
  } else if (hasPro) {
    els.getPro.textContent = 'Pro is active';
    els.proStatus.textContent = 'Thanks for supporting Pastebot. Every Pro feature is on.';
  } else {
    els.getPro.textContent = `Get Pro · ${PRO_PRICE}`;
    els.proStatus.textContent = `One payment of ${PRO_PRICE}, no subscription. Your data stays in this browser either way.`;
  }
}

// --- Setup ------------------------------------------------------------------------------

async function init(): Promise<void> {
  mountIcons();
  for (const action of ACTIONS) {
    if (isDirectAction(action.id)) els.defaultAction.append(h('option', { text: action.label, attrs: { value: action.id } }));
  }
  const browserLanguage = languageForLocale(chrome.i18n.getUILanguage()).name;
  els.translateTo.append(
    h('option', { text: `Browser language (${browserLanguage})`, attrs: { value: '' } }),
    ...TRANSLATE_LANGUAGES.map((language) => h('option', { text: language.name, attrs: { value: language.code } })),
  );
  renderMaskCategories();
  renderVariableChips();
  els.maskTryInput.value = MASK_SAMPLE;
  const [settings, plan, stored] = await Promise.all([loadSettings(), loadPlanState(), loadTemplates()]);
  planState = plan;
  templates = stored;
  els.maxHistory.max = String(historyMax());
  els.maxHistoryLimit.textContent = String(historyMax());
  els.historyLimitText.textContent = limitMessage('history');
  render(settings);
  renderTemplates();
  renderAboutPro();
  await renderShortcut();

  els.includePageContext.addEventListener('change', () => void save({ includePageContext: els.includePageContext.checked }));
  els.defaultAction.addEventListener('change', () => {
    if (isDirectAction(els.defaultAction.value)) void save({ defaultAction: els.defaultAction.value });
  });
  els.translateTo.addEventListener('change', () => void save({ translateTo: els.translateTo.value }));
  els.maskSecrets.addEventListener('change', () => void save({ maskSecrets: els.maskSecrets.checked }));
  els.maskTryInput.addEventListener('input', updateMaskTry);
  for (const input of styleInputs) {
    input.addEventListener('change', () => {
      if (input.checked && isPromptStyle(input.value)) void save({ promptStyle: input.value }).then(updatePreview);
    });
  }
  // `change` fires on blur/enter; invalid values are clamped by sanitizeSettings.
  els.maxHistory.addEventListener('change', saveHistorySize);
  els.changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  // Shortcuts can change on chrome://extensions/shortcuts while this page is open.
  window.addEventListener('focus', () => void renderShortcut());

  els.addTemplate.addEventListener('click', () => openEditor(null));
  els.cancelTemplate.addEventListener('click', closeEditor);
  els.editor.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitTemplate();
  });
  els.editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEditor();
  });
  els.templateInstruction.addEventListener('input', () => {
    updatePreview();
    if (els.templateInstruction.classList.contains('is-invalid')) showFieldErrors(null);
  });
  els.templateName.addEventListener('input', () => {
    if (els.templateName.classList.contains('is-invalid')) showFieldErrors(null);
  });
  els.exportTemplates.addEventListener('click', exportAll);
  els.importTemplates.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', () => {
    const file = els.importFile.files?.[0];
    els.importFile.value = '';
    if (file) void importFromFile(file);
  });
}

init().catch(() => showStatus("Couldn't load settings.", true));
