import {
  CONTENT_PLACEHOLDER,
  moveTemplate,
  removeTemplate,
  upsertTemplate,
  validateTemplate,
  type CustomTemplate,
} from '../core/customTemplates';
import { generatePrompt } from '../core/generate';
import { EARLY_ACCESS, PRO_FEATURES, PRO_PRICE, hasFeature, limitMessage, type ProFeature } from '../core/plan';
import { type Settings } from '../core/settings';
import { isDirectAction, isPromptStyle, type PromptStyle } from '../core/types';
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
  maxHistory: byId<HTMLInputElement>('max-history'),
  maxHistoryLimit: byId<HTMLSpanElement>('max-history-limit'),
  historyLimit: byId<HTMLParagraphElement>('history-limit'),
  historyLimitText: byId<HTMLSpanElement>('history-limit-text'),
  status: byId<HTMLSpanElement>('save-status'),
  shortcut: byId<HTMLElement>('shortcut'),
  changeShortcut: byId<HTMLButtonElement>('change-shortcut'),
  // Custom templates
  addTemplate: byId<HTMLButtonElement>('add-template'),
  templatesLocked: byId<HTMLParagraphElement>('templates-locked'),
  templatesLockedText: byId<HTMLSpanElement>('templates-locked-text'),
  editor: byId<HTMLFormElement>('template-editor'),
  editorTitle: byId<HTMLHeadingElement>('template-editor-title'),
  templateName: byId<HTMLInputElement>('template-name'),
  templateNameError: byId<HTMLDivElement>('template-name-error'),
  templateInstruction: byId<HTMLTextAreaElement>('template-instruction'),
  templateInstructionError: byId<HTMLDivElement>('template-instruction-error'),
  insertPlaceholder: byId<HTMLButtonElement>('insert-placeholder'),
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

let statusTimer: number | undefined;
let planState: PlanState | null = null;
let templates: CustomTemplate[] = [];
/** Id of the template being edited; null for a new one. */
let editingId: string | null = null;
let promptStyle: PromptStyle = 'balanced';

function pro(feature: ProFeature): boolean {
  return planState ? hasFeature(planState.plan, feature, planState.earlyAccess) : false;
}

// --- Settings ---------------------------------------------------------------------------

function render(settings: Settings): void {
  els.includePageContext.checked = settings.includePageContext;
  els.defaultAction.value = settings.defaultAction;
  els.maxHistory.value = String(Math.min(settings.maxHistoryItems, historyMax()));
  for (const input of styleInputs) input.checked = input.value === settings.promptStyle;
  promptStyle = settings.promptStyle;
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

/** Runs the real generator on sample text, so the preview is exactly what gets copied. */
function updatePreview(): void {
  const instruction = els.templateInstruction.value.trim();
  if (!instruction) {
    els.templatePreview.textContent = 'Write an instruction to see the prompt.';
    els.templatePreview.classList.add('placeholder-text');
    return;
  }
  const result = generatePrompt({ action: 'custom', selectedText: SAMPLE_TEXT, style: promptStyle, customInstruction: instruction });
  els.templatePreview.classList.toggle('placeholder-text', !result.ok);
  els.templatePreview.textContent = result.ok ? result.prompt : result.message;
}

function insertPlaceholder(): void {
  const field = els.templateInstruction;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(CONTENT_PLACEHOLDER, start, end, 'end');
  field.focus();
  updatePreview();
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
  els.insertPlaceholder.addEventListener('click', insertPlaceholder);
}

init().catch(() => showStatus("Couldn't load settings.", true));
