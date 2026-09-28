import alertIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import checkIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import errorIcon from 'bootstrap-icons/icons/x-circle-fill.svg';
import keyboardIcon from 'bootstrap-icons/icons/keyboard.svg';
import pencilIcon from 'bootstrap-icons/icons/pencil.svg';
import plusIcon from 'bootstrap-icons/icons/plus-lg.svg';
import searchIcon from 'bootstrap-icons/icons/search.svg';
import trashIcon from 'bootstrap-icons/icons/trash3.svg';
import infoIcon from 'bootstrap-icons/icons/info-circle.svg';
import tagIcon from 'bootstrap-icons/icons/tag.svg';
import uploadIcon from 'bootstrap-icons/icons/upload.svg';
import downloadIcon from 'bootstrap-icons/icons/download.svg';
import {
  buildExport,
  exportFileName,
  ImportError,
  ImportLimitError,
  parseImport,
  planImport,
  type ImportMode,
  type ImportPlan,
  type ParsedImport,
} from '../core/importExport';
import {
  canAddSnippets,
  defaultPlanState,
  EARLY_ACCESS,
  freeLimitMessage,
  hasFeature,
  isFreeLimit,
  limitsFor,
  planLabel,
  PRO_FEATURES,
  PRO_PRICE,
  type PlanState,
  type ProFeature,
} from '../core/plan';
import { buildIndex, findAllShadowed, findShadowing } from '../core/matcher';
import { previewParts } from '../core/preview';
import { defaultSettings, isTriggerMode, normalizeHostname, type Settings } from '../core/settings';
import { triggerChars } from '../core/suggest';
import { describeUsage, formatUsage, isSortOrder, sortByOrder, type UsageMap } from '../core/usage';
import {
  allTags,
  filterByTag,
  formatTags,
  hasErrors,
  lacksPrefixSymbol,
  normalizeDraft,
  normalizeTags,
  searchSnippets,
  validateDraft,
  type FieldErrors,
  type Snippet,
  type SnippetDraft,
  type SnippetField,
} from '../core/snippets';
import { CHOICE_HELP, expandTemplate, FIELD_HELP, hasFields, hasVariables, usesClipboard, VARIABLE_HELP, type FieldHelp } from '../core/variables';
import {
  deleteSnippet,
  importOptionsFor,
  importSnippets,
  loadPlanState,
  loadSettings,
  loadSnippets,
  loadUsage,
  onStoreChanged,
  restoreSnippet,
  saveSettings,
  saveSnippet,
  SnippetLimitError,
  SnippetValidationError,
} from '../storage/store';
import { hasClipboardAccess, onClipboardAccessChange, removeClipboardAccess, requestClipboardAccess } from '../ui/clipboardAccess';
import { byId, h } from '../ui/dom';
import { svgIcon } from '../ui/icons';
import { renderPreview } from '../ui/preview';

const els = {
  count: byId<HTMLSpanElement>('count'),
  importButton: byId<HTMLButtonElement>('import'),
  exportButton: byId<HTMLButtonElement>('export'),
  newButton: byId<HTMLButtonElement>('new'),
  searchIcon: byId<HTMLSpanElement>('search-icon'),
  search: byId<HTMLInputElement>('search'),
  sort: byId<HTMLSelectElement>('sort'),
  autocomplete: byId<HTMLInputElement>('autocomplete'),
  triggerExample: byId<HTMLElement>('trigger-example'),
  clipboardAccess: byId<HTMLDivElement>('clipboard-access'),
  limitAlert: byId<HTMLDivElement>('limit-alert'),
  tagFilter: byId<HTMLDivElement>('tag-filter'),
  aboutPro: byId<HTMLElement>('about-pro'),
  planStatus: byId<HTMLSpanElement>('plan-status'),
  proFeatures: byId<HTMLUListElement>('pro-features'),
  proPrice: byId<HTMLSpanElement>('pro-price'),
  proNote: byId<HTMLDivElement>('pro-note'),
  getPro: byId<HTMLButtonElement>('get-pro'),
  listAlert: byId<HTMLDivElement>('list-alert'),
  list: byId<HTMLUListElement>('list'),
  empty: byId<HTMLDivElement>('empty'),
  sites: byId<HTMLUListElement>('sites'),
  siteForm: byId<HTMLFormElement>('site-form'),
  siteInput: byId<HTMLInputElement>('site-input'),
  siteError: byId<HTMLDivElement>('site-error'),
  toasts: byId<HTMLDivElement>('toasts'),
  importDialog: byId<HTMLDialogElement>('import-dialog'),
  importFile: byId<HTMLInputElement>('import-file'),
  importError: byId<HTMLDivElement>('import-error'),
  importContent: byId<HTMLDivElement>('import-content'),
  importSummary: byId<HTMLParagraphElement>('import-summary'),
  importSkipped: byId<HTMLDivElement>('import-skipped'),
  importMergeHelp: byId<HTMLSpanElement>('import-merge-help'),
  importReplaceHelp: byId<HTMLSpanElement>('import-replace-help'),
  importCancel: byId<HTMLButtonElement>('import-cancel'),
  importConfirm: byId<HTMLButtonElement>('import-confirm'),
};
const triggerInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="trigger"]')];

let snippets: Snippet[] = [];
let settings: Settings = defaultSettings();
let plan: PlanState = defaultPlanState();
let usage: UsageMap = {};
/** Whether the optional clipboardRead permission is granted (for {clipboard}). */
let clipboardGranted = false;
let loaded = false;
/** Tag filter (Pro); null shows everything. */
let activeTag: string | null = null;
let highlightId: string | null = null;
let pendingImport: ParsedImport | null = null;

// --- Toasts -----------------------------------------------------------------------------

interface ToastOptions {
  variant?: 'success' | 'danger';
  action?: { label: string; run: () => void };
}

function toast(message: string, options: ToastOptions = {}): void {
  const variant = options.variant ?? 'success';
  const element = h('div', {
    class: `toast show toast-${variant}`,
    attrs: { role: variant === 'danger' ? 'alert' : 'status', 'aria-atomic': 'true' },
  });
  const remove = () => element.remove();
  const action = options.action;
  element.append(
    h(
      'div',
      { class: 'toast-body d-flex align-items-center gap-2' },
      svgIcon(variant === 'danger' ? errorIcon : checkIcon, 'toast-icon'),
      h('span', { class: 'me-auto', text: message }),
      action &&
        h('button', {
          class: 'btn btn-sm btn-link fw-semibold px-1 py-0',
          text: action.label,
          attrs: { type: 'button' },
          on: {
            click: () => {
              remove();
              action.run();
            },
          },
        }),
      h('button', { class: 'btn-close btn-close-sm', attrs: { type: 'button', 'aria-label': 'Dismiss' }, on: { click: remove } }),
    ),
  );
  while (els.toasts.children.length >= 3) els.toasts.firstElementChild?.remove();
  els.toasts.append(element);
  window.setTimeout(remove, variant === 'danger' ? 9000 : action ? 7000 : 3500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.';
}

// --- Plan -------------------------------------------------------------------------------

function can(feature: ProFeature): boolean {
  return hasFeature(plan.plan, feature, plan.earlyAccess);
}

function proBadge(): HTMLSpanElement {
  return h('span', { class: 'badge pro-badge', text: 'PRO', attrs: { title: 'Pro feature' } });
}

function showAboutPro(): void {
  els.aboutPro.scrollIntoView({ block: 'center', behavior: 'smooth' });
  els.aboutPro.focus({ preventScroll: true });
  els.aboutPro.classList.remove('flash');
  void els.aboutPro.offsetWidth;
  els.aboutPro.classList.add('flash');
}

function aboutProLink(): HTMLButtonElement {
  return h('button', { class: 'btn btn-link btn-sm p-0 align-baseline fw-semibold', text: 'About Pro', attrs: { type: 'button' }, on: { click: showAboutPro } });
}

function renderPro(): void {
  const label = planLabel(plan);
  els.planStatus.textContent = label === 'Free' ? 'Free plan' : label;
  els.planStatus.className = `badge plan-status plan-${label === 'Free' ? 'free' : 'pro'}`;
  els.proFeatures.replaceChildren(
    ...PRO_FEATURES.map((info) =>
      h('li', {}, h('div', { class: 'fw-semibold d-flex align-items-center gap-2' }, info.title, proBadge()), h('div', { class: 'form-text mt-0', text: info.description })),
    ),
  );
  els.proPrice.textContent = PRO_PRICE;
  const earlyAccess = plan.earlyAccess && plan.plan !== 'pro';
  els.proNote.textContent = plan.plan === 'pro' ? 'You have Pro. Thank you!' : earlyAccess ? 'Free during early access' : 'One-time payment, no subscription.';
  els.getPro.disabled = earlyAccess || plan.plan === 'pro';
  els.getPro.textContent = plan.plan === 'pro' ? 'Pro active' : 'Get Pro';
}

function atFreeLimit(): boolean {
  return isFreeLimit(plan) && !canAddSnippets(plan, snippets.length);
}

function renderLimit(): void {
  els.limitAlert.hidden = !atFreeLimit();
  if (els.limitAlert.hidden) return;
  els.limitAlert.replaceChildren(svgIcon(infoIcon, 'flex-none'), h('span', {}, `${freeLimitMessage()} Your snippets all keep working. `, aboutProLink()));
}

// --- Editor -----------------------------------------------------------------------------

interface Editor {
  id: string | null;
  element: HTMLLIElement;
  inputs: Record<SnippetField, HTMLInputElement | HTMLTextAreaElement>;
  feedback: Record<SnippetField, HTMLDivElement>;
  tagHelp: HTMLDivElement;
  tagSuggestions: HTMLDivElement;
  fieldChips: HTMLButtonElement[];
  warnings: HTMLDivElement;
  preview: HTMLDivElement;
  previewBody: HTMLDivElement;
  saveError: HTMLDivElement;
  hint: HTMLSpanElement;
  save: HTMLButtonElement;
  initial: string;
  submitted: boolean;
  escapeArmed: number | undefined;
}

let editor: Editor | null = null;

function draftOf(current: Editor): SnippetDraft {
  return normalizeDraft({
    abbreviation: current.inputs.abbreviation.value,
    text: current.inputs.text.value,
    label: current.inputs.label.value,
    tags: current.inputs.tags.value,
  });
}

function isDirty(current: Editor): boolean {
  return JSON.stringify(draftOf(current)) !== current.initial;
}

function createEditor(snippet: Snippet | null): Editor {
  const field = (id: SnippetField, labelText: string, control: HTMLInputElement | HTMLTextAreaElement, help?: string, optional = false, pro = false) => {
    control.id = `editor-${id}`;
    control.classList.add('form-control');
    const feedback = h('div', { class: 'invalid-feedback', attrs: { id: `editor-${id}-feedback` } });
    const describedBy = [`editor-${id}-feedback`];
    const helpElement = help ? h('div', { class: 'form-text', text: help, attrs: { id: `editor-${id}-help` } }) : null;
    if (helpElement) describedBy.push(helpElement.id);
    control.setAttribute('aria-describedby', describedBy.join(' '));
    const label = h(
      'label',
      { class: 'form-label', attrs: { for: control.id } },
      labelText,
      optional && h('span', { class: 'text-body-secondary fw-normal', text: ' (optional)' }),
      pro && ' ',
      pro && proBadge(),
    );
    return { wrapper: [label, control, feedback, helpElement] as const, feedback, help: helpElement };
  };

  const abbreviation = h('input', {
    class: 'font-mono',
    attrs: { type: 'text', placeholder: ';sig', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' },
  });
  const label = h('input', { attrs: { type: 'text', placeholder: 'Email signature', autocomplete: 'off' } });
  const text = h('textarea', { attrs: { rows: '5', placeholder: 'Best regards,\nAlex', spellcheck: 'true' } });
  const tags = h('input', { attrs: { type: 'text', placeholder: 'work, replies', autocomplete: 'off', spellcheck: 'false' } });
  abbreviation.value = snippet?.abbreviation ?? '';
  label.value = snippet?.label ?? '';
  text.value = snippet?.text ?? '';
  tags.value = formatTags(snippet?.tags);

  const abbreviationField = field('abbreviation', 'Abbreviation', abbreviation, 'No spaces. A symbol like ; in front keeps it from firing in normal words.');
  const labelField = field('label', 'Label', label, undefined, true);
  const textField = field('text', 'Text', text);
  const tagsField = field('tags', 'Tags', tags, 'Separate with commas. Filter by tag here and in the toolbar popup.', true, true);
  const tagSuggestions = h('div', { class: 'tag-suggestions', attrs: { role: 'group', 'aria-label': 'Add an existing tag' } });

  const variableBar = h(
    'div',
    { class: 'variable-bar', attrs: { role: 'group', 'aria-label': 'Insert a variable' } },
    h('span', { class: 'form-text m-0', text: 'Insert' }),
    ...VARIABLE_HELP.map((variable) =>
      h('button', {
        class: 'btn btn-sm btn-outline-secondary font-mono',
        text: variable.token,
        attrs: { type: 'button', title: variable.description },
        on: { click: () => insertAtCaret(text, variable.token) },
      }),
    ),
  );
  const fieldChip = (help: FieldHelp) =>
    h(
      'button',
      {
        class: 'btn btn-sm btn-outline-secondary font-mono field-chip',
        attrs: { type: 'button', title: help.description },
        on: {
          click: () => {
            const start = text.selectionStart;
            insertAtCaret(text, help.token);
            // Select "Name" so the field can be named right away.
            const at = start + help.token.indexOf(help.select);
            text.setSelectionRange(at, at + help.select.length);
          },
        },
      },
      help.chip,
      ' ',
      proBadge(),
    );
  const fieldChips = [fieldChip(FIELD_HELP), fieldChip(CHOICE_HELP)];
  variableBar.append(...fieldChips);
  const variableHelp = renderVariableHelp();

  const warnings = h('div', { class: 'alert alert-warning small py-2 mb-0', attrs: { role: 'status' } });
  warnings.hidden = true;
  const previewBody = h('div', { class: 'preview-body' });
  const preview = h('div', { class: 'preview' }, h('div', { class: 'section-label mb-1', text: 'Preview' }), previewBody);
  preview.hidden = true;
  const saveError = h('div', { class: 'alert alert-danger small py-2 mb-0', attrs: { role: 'alert' } });
  saveError.hidden = true;
  const hint = h('span', { class: 'form-text m-0 me-auto', text: 'Ctrl+Enter saves · Esc cancels' });
  const save = h('button', { class: 'btn btn-primary btn-sm', text: snippet ? 'Save' : 'Create snippet', attrs: { type: 'submit' } });
  const cancel = h('button', { class: 'btn btn-outline-secondary btn-sm', text: 'Cancel', attrs: { type: 'button' } });

  const form = h(
    'form',
    { class: 'editor-form', attrs: { novalidate: '' } },
    h(
      'div',
      { class: 'editor-grid' },
      h('div', {}, ...abbreviationField.wrapper),
      h('div', {}, ...labelField.wrapper),
      h('div', { class: 'span-all' }, ...textField.wrapper, variableBar, variableHelp),
      h('div', { class: 'span-all' }, ...tagsField.wrapper, tagSuggestions),
      h('div', { class: 'span-all' }, warnings),
      h('div', { class: 'span-all' }, preview),
      h('div', { class: 'span-all' }, saveError),
    ),
    h('div', { class: 'editor-actions' }, hint, cancel, save),
  );
  const element = h(
    'li',
    { class: 'list-group-item editor', attrs: { 'aria-label': snippet ? `Edit ${snippet.abbreviation}` : 'New snippet' } },
    h('div', { class: 'section-label mb-3', text: snippet ? 'Edit snippet' : 'New snippet' }),
    form,
  );

  const current: Editor = {
    id: snippet?.id ?? null,
    element,
    inputs: { abbreviation, label, text, tags },
    feedback: { abbreviation: abbreviationField.feedback, label: labelField.feedback, text: textField.feedback, tags: tagsField.feedback },
    tagHelp: tagsField.help as HTMLDivElement,
    tagSuggestions,
    fieldChips,
    warnings,
    preview,
    previewBody,
    saveError,
    hint,
    save,
    initial: '',
    submitted: false,
    escapeArmed: undefined,
  };
  current.initial = JSON.stringify(draftOf(current));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitEditor(current);
  });
  form.addEventListener('input', () => {
    current.saveError.hidden = true;
    fitText(text);
    updateEditor(current);
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submitEditor(current);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      requestCancel(current);
    }
  });
  cancel.addEventListener('click', () => closeEditor());
  updateEditor(current);
  return current;
}

/** The text box grows with its content (up to a limit, then it scrolls). */
function fitText(textarea: HTMLTextAreaElement): void {
  if (!textarea.isConnected) return;
  textarea.style.height = '';
  const border = textarea.offsetHeight - textarea.clientHeight;
  if (textarea.scrollHeight > textarea.clientHeight) textarea.style.height = `${Math.min(textarea.scrollHeight + border, 480)}px`;
}

function insertAtCaret(textarea: HTMLTextAreaElement, token: string): void {
  textarea.focus();
  // execCommand keeps the textarea's undo history; setRangeText is the fallback.
  if (!document.execCommand('insertText', false, token)) {
    textarea.setRangeText(token, textarea.selectionStart, textarea.selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function requestCancel(current: Editor): void {
  if (!isDirty(current) || current.escapeArmed !== undefined) {
    closeEditor();
    return;
  }
  current.hint.textContent = 'Press Esc again to discard your changes';
  current.hint.classList.add('text-warning-emphasis');
  current.escapeArmed = window.setTimeout(() => {
    current.escapeArmed = undefined;
    current.hint.textContent = 'Ctrl+Enter saves · Esc cancels';
    current.hint.classList.remove('text-warning-emphasis');
  }, 3000);
}

function othersThan(id: string | null): Snippet[] {
  return snippets.filter((snippet) => snippet.id !== id);
}

const FIELD_ORDER = ['abbreviation', 'label', 'text', 'tags'] as const;

function showFieldErrors(current: Editor, errors: FieldErrors): void {
  for (const name of FIELD_ORDER) {
    const message = errors[name];
    current.inputs[name].classList.toggle('is-invalid', !!message);
    current.inputs[name].setAttribute('aria-invalid', message ? 'true' : 'false');
    current.feedback[name].textContent = message ?? '';
  }
}

function warningsFor(draft: SnippetDraft, id: string | null): string[] {
  const warnings: string[] = [];
  if (!draft.abbreviation || /\s/.test(draft.abbreviation)) return warnings;
  if (lacksPrefixSymbol(draft.abbreviation)) {
    warnings.push(`${draft.abbreviation} is an ordinary word, so it can expand while you type normal text. A prefix like ;${draft.abbreviation} avoids that.`);
  }
  if (settings.triggerMode === 'immediate') {
    const others = othersThan(id);
    const blockedBy = findShadowing(draft.abbreviation, buildIndex(others));
    if (blockedBy) warnings.push(`${draft.abbreviation} will never expand as you type: ${blockedBy} expands first.`);
    const withDraft = buildIndex([...others, { ...draft, id: '' }]);
    const blocked = others.filter((snippet) => findShadowing(snippet.abbreviation, withDraft) === draft.abbreviation);
    if (blocked.length) {
      const names = blocked.map((snippet) => snippet.abbreviation).sort().join(', ');
      warnings.push(`${names} will never expand as you type once this is saved: ${draft.abbreviation} expands first.`);
    }
  }
  if (!can('fill-in-fields') && hasFields(draft.text)) {
    warnings.push('Fill-in fields are part of Pro. On Free, {input:…} and {choice:…} are inserted exactly as written.');
  }
  return warnings;
}

function updateEditor(current: Editor): void {
  const draft = draftOf(current);
  if (current.submitted) showFieldErrors(current, validateDraft(draft, othersThan(current.id)));

  const warnings = warningsFor(draft, current.id);
  const clipboardWarning = clipboardWarningFor(draft);
  current.warnings.replaceChildren(
    ...warnings.map((warning) => h('div', { class: 'd-flex gap-2' }, svgIcon(alertIcon, 'mt-1'), h('span', { text: warning }))),
    ...(clipboardWarning ? [clipboardWarning] : []),
  );
  current.warnings.hidden = warnings.length === 0 && !clipboardWarning;

  // Pro state of the tag input and the fill-in chip follows the plan live.
  const tagsAllowed = can('tags');
  current.inputs.tags.disabled = !tagsAllowed;
  current.tagHelp.replaceChildren(
    ...(tagsAllowed ? ['Separate with commas. Filter by tag here and in the toolbar popup.'] : ['Tags are part of Pro; existing tags are kept. ', aboutProLink()]),
  );
  for (const chip of current.fieldChips) chip.disabled = !can('fill-in-fields');
  renderTagSuggestions(current, tagsAllowed ? draft.tags ?? [] : null);

  const showPreview = hasVariables(draft.text);
  current.preview.hidden = !showPreview;
  if (showPreview) {
    // The same rendering as the list rows and the popup: variables as chips, {cursor} as a caret.
    const parts = previewParts(draft.text, { now: new Date(), locale: navigator.language, fields: can('fill-in-fields') });
    current.previewBody.replaceChildren(...renderPreview(parts));
  }
}

/** {clipboard} without clipboard access inserts nothing: say so, and offer to allow it. */
function clipboardWarningFor(draft: SnippetDraft): HTMLDivElement | null {
  if (!usesClipboard(draft.text) || clipboardGranted) return null;
  return h(
    'div',
    { class: 'd-flex gap-2 clipboard-warning' },
    svgIcon(alertIcon, 'mt-1'),
    h(
      'div',
      {},
      h('div', { class: 'fw-semibold', text: 'Clipboard access is off, so {clipboard} inserts nothing.' }),
      h('div', {
        text: 'Saving asks Chrome to let Snippets read your clipboard. It is read only at the moment a {clipboard} snippet expands or is copied, and nothing is kept.',
      }),
      h('button', {
        class: 'btn btn-sm btn-outline-secondary mt-2',
        text: 'Allow clipboard access',
        attrs: { type: 'button' },
        on: { click: () => void allowClipboard() },
      }),
    ),
  );
}

async function allowClipboard(): Promise<boolean> {
  const granted = await requestClipboardAccess();
  await refreshClipboardAccess();
  if (!granted) toast("Clipboard access wasn't allowed. {clipboard} inserts nothing until you allow it.", { variant: 'danger' });
  return granted;
}

async function refreshClipboardAccess(): Promise<void> {
  clipboardGranted = await hasClipboardAccess();
  renderClipboardAccess();
  if (editor) updateEditor(editor);
}

function renderClipboardAccess(): void {
  const users = snippets.filter((snippet) => usesClipboard(snippet.text)).length;
  const label = h('span', { class: 'fw-semibold', text: 'Clipboard access: ' });
  if (clipboardGranted) {
    els.clipboardAccess.replaceChildren(
      h('div', {}, label, 'allowed, for {clipboard}. Read only when such a snippet expands.'),
      h('button', {
        class: 'btn btn-link btn-sm p-0 fw-semibold',
        text: 'Remove access',
        attrs: { type: 'button' },
        on: {
          click: () =>
            void removeClipboardAccess()
              .then(refreshClipboardAccess)
              .then(() => toast('Clipboard access removed')),
        },
      }),
    );
    return;
  }
  const status = h('div', {}, label, users > 0 ? `off. ${plural(users, 'snippet uses', 'snippets use')} {clipboard}, which inserts nothing without it.` : 'off (only needed for {clipboard}).');
  if (users === 0) {
    els.clipboardAccess.replaceChildren(status);
    return;
  }
  els.clipboardAccess.replaceChildren(
    status,
    h('button', {
      class: 'btn btn-link btn-sm p-0 fw-semibold',
      text: 'Allow clipboard access',
      attrs: { type: 'button' },
      on: { click: () => void allowClipboard() },
    }),
  );
}

/** Existing tags not on this snippet yet, one click to add. `null` hides them (free plan). */
function renderTagSuggestions(current: Editor, tags: readonly string[] | null): void {
  const present = new Set((tags ?? []).map((tag) => tag.toLocaleLowerCase()));
  const offered = tags === null ? [] : allTags(snippets).filter((entry) => !present.has(entry.tag.toLocaleLowerCase())).slice(0, 12);
  current.tagSuggestions.hidden = offered.length === 0;
  current.tagSuggestions.replaceChildren(
    ...offered.map((entry) =>
      h('button', {
        class: 'btn btn-sm tag-chip',
        text: `+ ${entry.tag}`,
        attrs: { type: 'button', title: `Add the tag ${entry.tag}` },
        on: {
          click: () => {
            const input = current.inputs.tags;
            input.value = formatTags([...normalizeTags(input.value), entry.tag]);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
          },
        },
      }),
    ),
  );
}

function openEditor(snippet: Snippet | null): void {
  if (!snippet && !canAddSnippets(plan, snippets.length)) {
    // Calm and inline: the message is already on the list; draw attention to it.
    renderLimit();
    if (!els.limitAlert.hidden) {
      els.limitAlert.classList.remove('flash');
      void els.limitAlert.offsetWidth;
      els.limitAlert.classList.add('flash');
      els.limitAlert.querySelector<HTMLButtonElement>('button')?.focus();
    } else {
      toast(`You can have up to ${limitsFor(plan.plan, plan.earlyAccess).maxSnippets} snippets.`, { variant: 'danger' });
    }
    return;
  }
  if (editor) {
    if (editor.id === (snippet?.id ?? null) && snippet) {
      editor.inputs.text.focus();
      return;
    }
    if (isDirty(editor)) {
      editor.saveError.textContent = 'Save or cancel this snippet first.';
      editor.saveError.hidden = false;
      editor.element.scrollIntoView({ block: 'nearest' });
      editor.inputs.abbreviation.focus();
      return;
    }
    editor = null;
  }
  editor = createEditor(snippet);
  render();
  fitText(editor.inputs.text as HTMLTextAreaElement);
  editor.element.scrollIntoView({ block: 'nearest' });
  (snippet ? editor.inputs.text : editor.inputs.abbreviation).focus();
}

function closeEditor(focusId: string | null = editor?.id ?? null): void {
  if (!editor) return;
  window.clearTimeout(editor.escapeArmed);
  editor = null;
  render();
  const row = focusId ? els.list.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusId)}"] .edit`) : null;
  (row ?? els.newButton).focus();
}

async function submitEditor(current: Editor): Promise<void> {
  current.submitted = true;
  const draft = draftOf(current);
  const errors = validateDraft(draft, othersThan(current.id));
  showFieldErrors(current, errors);
  if (hasErrors(errors)) {
    const first = FIELD_ORDER.find((name) => errors[name]);
    if (first) current.inputs[first].focus();
    return;
  }
  // Chrome only shows the permission prompt during the click or key press, so ask before
  // anything else is awaited. No prompt when access is already granted.
  const clipboard = usesClipboard(draft.text) ? requestClipboardAccess() : null;
  current.save.disabled = true;
  try {
    const result = await saveSnippet(draft, current.id);
    snippets = result.snippets;
    highlightId = result.snippet.id;
    closeEditor(result.snippet.id);
    toast(current.id ? `Saved ${result.snippet.abbreviation}` : `Created ${result.snippet.abbreviation}`);
    if (clipboard) {
      const granted = await clipboard;
      await refreshClipboardAccess();
      if (!granted) toast(`Clipboard access wasn't allowed, so {clipboard} in ${result.snippet.abbreviation} inserts nothing.`, { variant: 'danger' });
    }
  } catch (error) {
    if (error instanceof SnippetValidationError) {
      showFieldErrors(current, error.errors);
    } else if (error instanceof SnippetLimitError) {
      current.saveError.replaceChildren(`${error.message} `, error.freeLimit ? aboutProLink() : '');
      current.saveError.hidden = false;
      renderLimit();
    } else {
      current.saveError.textContent = `Couldn't save: ${errorMessage(error)}`;
      current.saveError.hidden = false;
    }
  } finally {
    current.save.disabled = false;
  }
}

// --- List -------------------------------------------------------------------------------

function renderRow(snippet: Snippet, blockedBy: string | undefined): HTMLLIElement {
  const head = h(
    'div',
    { class: 'snippet-head' },
    h('span', { class: 'abbr', text: snippet.abbreviation }),
    snippet.label && h('span', { class: 'snippet-label text-truncate', text: snippet.label }),
    ...(snippet.tags ?? []).map((tag) =>
      can('tags')
        ? h('button', {
            class: 'tag',
            text: tag,
            attrs: { type: 'button', title: `Show only snippets tagged ${tag}`, 'aria-label': `Filter by tag ${tag}` },
            on: {
              click: (event) => {
                event.stopPropagation();
                setTagFilter(tag);
              },
            },
          })
        : h('span', { class: 'tag', text: tag }),
    ),
    blockedBy &&
      h(
        'span',
        {
          class: 'badge warning-badge',
          attrs: { title: `While you type ${snippet.abbreviation}, ${blockedBy} expands first. Change one of them or switch to "After Space, Tab or Enter".` },
        },
        svgIcon(alertIcon),
        ` Never expands: ${blockedBy} fires first`,
      ),
  );
  const now = Date.now();
  const entry = usage[snippet.id];
  head.append(h('span', { class: 'usage-meta ms-auto', text: formatUsage(entry, now) ?? 'not used yet', attrs: { title: describeUsage(entry, now) } }));
  const main = h(
    'div',
    { class: 'snippet-main', on: { click: () => openEditor(snippet) } },
    head,
    // The same preview as the popup; blank lines collapsed so the two lines show content.
    h('div', { class: 'snippet-text' }, ...renderPreview(previewParts(snippet.text, { now: new Date(now), locale: navigator.language, fields: can('fill-in-fields') }))),
  );
  const edit = h(
    'button',
    { class: 'btn btn-icon edit', attrs: { type: 'button', 'aria-label': `Edit ${snippet.abbreviation}`, title: 'Edit' }, on: { click: () => openEditor(snippet) } },
    svgIcon(pencilIcon),
  );
  const remove = h(
    'button',
    { class: 'btn btn-icon delete', attrs: { type: 'button', 'aria-label': `Delete ${snippet.abbreviation}`, title: 'Delete' }, on: { click: () => void removeSnippet(snippet) } },
    svgIcon(trashIcon),
  );
  const row = h('li', { class: 'list-group-item snippet-row', attrs: { 'data-id': snippet.id } }, main, h('div', { class: 'snippet-actions' }, edit, remove));
  if (snippet.id === highlightId) {
    row.classList.add('highlight');
    window.setTimeout(() => row.classList.remove('highlight'), 1600);
  }
  return row;
}

function renderEmpty(): void {
  const query = els.search.value.trim();
  if (snippets.length === 0) {
    els.empty.replaceChildren(
      svgIcon(keyboardIcon, 'empty-icon'),
      h('p', { class: 'fw-semibold text-body', text: 'No snippets yet' }),
      h('p', { text: 'Create one, type its abbreviation in any text field, and it turns into the full text.' }),
      h('button', { class: 'btn btn-primary btn-sm mt-2', text: 'Create your first snippet', attrs: { type: 'button' }, on: { click: () => openEditor(null) } }),
    );
  } else if (!query && activeTag !== null) {
    els.empty.replaceChildren(
      svgIcon(tagIcon, 'empty-icon'),
      h('p', { text: `No snippets are tagged ${activeTag}.` }),
      h('button', { class: 'btn btn-outline-secondary btn-sm mt-1', text: 'Show all', attrs: { type: 'button' }, on: { click: () => setTagFilter(null) } }),
    );
  } else {
    els.empty.replaceChildren(
      svgIcon(searchIcon, 'empty-icon'),
      h('p', { text: activeTag === null ? `No snippets match "${query}".` : `No snippets tagged ${activeTag} match "${query}".` }),
      h('button', {
        class: 'btn btn-outline-secondary btn-sm mt-1',
        text: 'Clear search',
        attrs: { type: 'button' },
        on: {
          click: () => {
            els.search.value = '';
            render();
            els.search.focus();
          },
        },
      }),
    );
  }
}

function render(): void {
  if (!loaded) return;
  // Re-rendering replaces rows and moves the editor node; keep focus (and the caret) where it was.
  const active = document.activeElement;
  const activeRow = active instanceof HTMLElement && !editor?.element.contains(active) ? active.closest<HTMLElement>('.snippet-row') : null;
  const restoreRow =
    activeRow?.dataset.id && els.list.contains(activeRow) ? { id: activeRow.dataset.id, action: active?.classList.contains('delete') ? 'delete' : 'edit' } : null;
  const restore =
    editor && active instanceof HTMLElement && editor.element.contains(active)
      ? {
          element: active,
          selection:
            active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
              ? ([active.selectionStart, active.selectionEnd] as const)
              : null,
        }
      : null;

  const free = isFreeLimit(plan);
  const max = limitsFor(plan.plan, plan.earlyAccess).maxSnippets;
  els.count.textContent = free ? `${snippets.length} / ${max}` : String(snippets.length);
  els.count.title = free ? `Free keeps ${max} snippets` : '';
  els.count.hidden = false;
  els.exportButton.disabled = snippets.length === 0;
  renderLimit();
  renderTagFilter();
  const visible = filterByTag(searchSnippets(snippets, els.search.value, (list) => sortByOrder(list, settings.managerSort, usage)), activeTag);
  const shadowed = settings.triggerMode === 'immediate' ? findAllShadowed(snippets.map((snippet) => snippet.abbreviation)) : new Map<string, string>();
  const rows: HTMLLIElement[] = [];
  if (editor && editor.id === null) rows.push(editor.element);
  for (const snippet of visible) {
    rows.push(editor?.id === snippet.id ? editor.element : renderRow(snippet, shadowed.get(snippet.abbreviation)));
  }
  // An edited snippet hidden by the search stays open at the top.
  if (editor && editor.id !== null && !visible.some((snippet) => snippet.id === editor?.id)) rows.unshift(editor.element);
  els.list.replaceChildren(...rows);
  els.list.setAttribute('aria-busy', 'false');
  els.list.hidden = rows.length === 0;
  els.empty.hidden = rows.length > 0;
  if (rows.length === 0) renderEmpty();
  highlightId = null;

  if (restoreRow) {
    els.list.querySelector<HTMLElement>(`[data-id="${CSS.escape(restoreRow.id)}"] .${restoreRow.action}`)?.focus({ preventScroll: true });
  }
  if (restore && restore.element.isConnected) {
    restore.element.focus({ preventScroll: true });
    if (restore.selection && (restore.element instanceof HTMLInputElement || restore.element instanceof HTMLTextAreaElement)) {
      restore.element.setSelectionRange(restore.selection[0], restore.selection[1]);
    }
  }
}

// --- Tag filter (Pro) ---------------------------------------------------------------------

function setTagFilter(tag: string | null): void {
  activeTag = tag;
  render();
  const selector = tag === null ? '[data-tag=""]' : `[data-tag="${CSS.escape(tag.toLocaleLowerCase())}"]`;
  els.tagFilter.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
}

function renderTagFilter(): void {
  const tags = can('tags') ? allTags(snippets) : [];
  if (activeTag !== null && !tags.some((entry) => entry.tag.toLocaleLowerCase() === activeTag?.toLocaleLowerCase())) activeTag = null;
  els.tagFilter.hidden = tags.length === 0;
  if (tags.length === 0) {
    els.tagFilter.replaceChildren();
    return;
  }
  const chip = (label: string, tag: string | null, count: number) => {
    const pressed = tag === null ? activeTag === null : activeTag !== null && tag.toLocaleLowerCase() === activeTag.toLocaleLowerCase();
    return h(
      'button',
      {
        class: `btn btn-sm filter-chip${pressed ? ' active' : ''}`,
        attrs: { type: 'button', 'aria-pressed': String(pressed), 'data-tag': tag === null ? '' : tag.toLocaleLowerCase() },
        on: { click: () => setTagFilter(pressed && tag !== null ? null : tag) },
      },
      label,
      h('span', { class: 'filter-count tabular', text: String(count) }),
    );
  };
  els.tagFilter.replaceChildren(
    h('span', { class: 'filter-label' }, svgIcon(tagIcon), ' Tags ', proBadge()),
    chip('All', null, snippets.length),
    ...tags.map((entry) => chip(entry.tag, entry.tag, entry.count)),
  );
}

async function removeSnippet(snippet: Snippet): Promise<void> {
  const rows = [...els.list.querySelectorAll<HTMLElement>('.snippet-row')];
  const position = rows.findIndex((row) => row.dataset.id === snippet.id);
  try {
    const removed = await deleteSnippet(snippet.id);
    snippets = snippets.filter((entry) => entry.id !== snippet.id);
    render();
    const next = els.list.querySelectorAll<HTMLElement>('.snippet-row .edit')[Math.max(0, position)] ?? els.newButton;
    next.focus();
    if (!removed) return;
    toast(`Deleted ${removed.abbreviation}`, {
      action: {
        label: 'Undo',
        run: () => {
          restoreSnippet(removed)
            .then(() => {
              snippets = [...snippets.filter((entry) => entry.id !== removed.id), removed];
              highlightId = removed.id;
              render();
              toast(`Restored ${removed.abbreviation}`);
            })
            .catch((error: unknown) => toast(`Couldn't restore ${removed.abbreviation}: ${errorMessage(error)}`, { variant: 'danger' }));
        },
      },
    });
  } catch (error) {
    toast(`Couldn't delete ${snippet.abbreviation}: ${errorMessage(error)}`, { variant: 'danger' });
  }
}

// --- Settings ---------------------------------------------------------------------------

function renderSettings(): void {
  for (const input of triggerInputs) input.checked = input.value === settings.triggerMode;
  els.autocomplete.checked = settings.autocomplete;
  els.sort.value = settings.managerSort;
  renderTriggerExample();
  if (settings.disabledSites.length === 0) {
    els.sites.replaceChildren(h('li', { class: 'list-group-item small text-body-secondary', text: 'No sites disabled.' }));
    return;
  }
  els.sites.replaceChildren(
    ...settings.disabledSites.map((site) =>
      h(
        'li',
        { class: 'list-group-item d-flex align-items-center justify-content-between gap-2 py-1 pe-2' },
        h('span', { class: 'font-mono small text-truncate', text: site }),
        h('button', {
          class: 'btn-close btn-close-sm',
          attrs: { type: 'button', 'aria-label': `Enable on ${site} again`, title: 'Remove' },
          on: { click: () => void updateSites(settings.disabledSites.filter((entry) => entry !== site), `Snippets is back on ${site}`) },
        }),
      ),
    ),
  );
}

async function updateSites(disabledSites: string[], message: string): Promise<boolean> {
  try {
    settings = await saveSettings({ disabledSites });
    renderSettings();
    toast(message);
    return true;
  } catch (error) {
    toast(`Couldn't save: ${errorMessage(error)}`, { variant: 'danger' });
    return false;
  }
}

function showSiteError(message: string): void {
  els.siteInput.classList.toggle('is-invalid', !!message);
  els.siteError.textContent = message;
}

async function addSite(): Promise<void> {
  const host = normalizeHostname(els.siteInput.value);
  if (!host) {
    showSiteError('Enter a site like example.com.');
    return;
  }
  if (settings.disabledSites.includes(host)) {
    showSiteError(`${host} is already in the list.`);
    return;
  }
  showSiteError('');
  if (await updateSites([...settings.disabledSites, host], `Snippets won't expand on ${host}`)) els.siteInput.value = '';
}

/** Shows which characters open suggestions (the symbols the abbreviations start with). */
function renderTriggerExample(): void {
  const triggers = [...triggerChars(snippets.map((snippet) => snippet.abbreviation))];
  els.triggerExample.textContent = triggers.length ? triggers.slice(0, 3).join(' ') : ';';
}

/** The variables reference, folded under the editor's chips. */
function renderVariableHelp(): HTMLDetailsElement {
  const now = new Date();
  const list = h(
    'dl',
    { class: 'variables' },
    ...VARIABLE_HELP.flatMap((variable) => {
      const live = variable.token !== '{cursor}' && variable.token !== '{clipboard}';
      const example = live ? expandTemplate(variable.token, { now, locale: navigator.language }).text : '';
      return [
        h('dt', {}, h('code', { text: variable.token })),
        h('dd', {}, variable.description, example && h('span', { class: 'text-body-secondary', text: ` · ${example}` })),
      ];
    }),
    h('dt', {}, h('code', { text: FIELD_HELP.token })),
    h('dd', {}, 'Asks for a value when the snippet expands. ', h('code', { text: '{input:Name=default}' }), ' fills it in. ', proBadge()),
    h('dt', {}, h('code', { text: '{choice:Name=A|B|C}' })),
    h('dd', {}, 'A dropdown with these options when the snippet expands; the first is preselected. ', proBadge()),
  );
  return h(
    'details',
    { class: 'variable-help' },
    h('summary', { text: 'What the variables do' }),
    list,
    h(
      'p',
      { class: 'form-text mb-0' },
      'Date formats: ',
      ...['YYYY', 'MM', 'DD', 'MMMM'].flatMap((token) => [h('code', { text: token }), ' ']),
      '(month name) ',
      h('code', { text: 'dddd' }),
      ' (weekday) ',
      h('code', { text: 'HH:mm' }),
      ' ',
      h('code', { text: 'h:mm A' }),
      '. Text in ',
      h('code', { text: '[brackets]' }),
      ' is kept as is. Any other ',
      h('code', { text: '{text}' }),
      ' in braces is left untouched.',
    ),
  );
}

// --- Import / export --------------------------------------------------------------------

function exportSnippets(): void {
  const now = new Date();
  const url = URL.createObjectURL(new Blob([buildExport(snippets, now)], { type: 'application/json' }));
  const link = h('a', { attrs: { href: url, download: exportFileName(now) } });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  toast(`Exported ${snippets.length} ${snippets.length === 1 ? 'snippet' : 'snippets'}`);
}

function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

function showImportError(message: string): void {
  pendingImport = null;
  els.importError.replaceChildren(
    h('div', { class: 'fw-semibold', text: "Couldn't read this file" }),
    h('div', { text: message }),
    h('div', { class: 'small mt-1', text: 'Choose a file exported from Snippets, or a JSON list of { "abbreviation", "text", "label" } objects.' }),
  );
  els.importError.hidden = false;
  els.importContent.hidden = true;
  els.importConfirm.hidden = true;
  els.importCancel.textContent = 'Close';
}

async function onImportFile(file: File): Promise<void> {
  els.importError.hidden = true;
  els.importContent.hidden = false;
  els.importConfirm.hidden = false;
  els.importCancel.textContent = 'Cancel';
  try {
    const parsed = parseImport(await file.text());
    pendingImport = parsed;
    els.importSummary.replaceChildren(`Found ${plural(parsed.drafts.length, 'snippet')} in `, h('span', { class: 'fw-semibold', text: file.name }), '.');
    if (parsed.skipped.length) {
      const shown = parsed.skipped.slice(0, 5);
      els.importSkipped.replaceChildren(
        h('div', { class: 'fw-semibold mb-1', text: `${plural(parsed.skipped.length, 'entry', 'entries')} will be skipped:` }),
        h(
          'ul',
          { class: 'mb-0 ps-3' },
          ...shown.map((item) => h('li', { text: `#${item.position}${item.abbreviation ? ` ${item.abbreviation}` : ''}: ${item.reason}` })),
          parsed.skipped.length > shown.length && h('li', { text: `and ${parsed.skipped.length - shown.length} more` }),
        ),
      );
      els.importSkipped.hidden = false;
    } else {
      els.importSkipped.hidden = true;
    }
    const options = importOptionsFor(plan);
    const attempt = (mode: ImportMode): ImportPlan | ImportError => {
      try {
        return planImport(snippets, parsed.drafts, mode, () => '', 0, options);
      } catch (error) {
        if (error instanceof ImportError) return error;
        throw error;
      }
    };
    const limitText = (error: ImportError) =>
      error instanceof ImportLimitError && isFreeLimit(plan) ? `${freeLimitMessage()} This would make ${error.total}.` : error.message;
    const merge = attempt('merge');
    const replace = attempt('replace');
    importBlocked = { merge: merge instanceof ImportError, replace: replace instanceof ImportError };
    if (merge instanceof ImportError) {
      els.importMergeHelp.replaceChildren(limitText(merge), ' ', isFreeLimit(plan) ? aboutProLinkClosingDialog() : '');
    } else {
      const parts: string[] = [];
      if (merge.added) parts.push(`adds ${plural(merge.added, 'new snippet')}`);
      if (merge.updated) parts.push(`updates ${merge.updated} with the same abbreviation`);
      if (merge.unchanged) parts.push(`${merge.unchanged} already up to date`);
      const sentence = parts.join(', ');
      els.importMergeHelp.textContent = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
    }
    els.importMergeHelp.classList.toggle('text-warning-emphasis', importBlocked.merge);
    if (replace instanceof ImportError) {
      els.importReplaceHelp.replaceChildren(limitText(replace));
    } else {
      els.importReplaceHelp.textContent =
        snippets.length > 0 ? `Your ${plural(snippets.length, 'current snippet')} will be deleted first.` : 'You have no snippets yet.';
    }
    els.importReplaceHelp.classList.toggle('text-danger-emphasis', !importBlocked.replace && snippets.length > 0);
    els.importReplaceHelp.classList.toggle('text-warning-emphasis', importBlocked.replace);
    // Merge is always the default: Replace deletes, so it's never chosen for the user.
    byId<HTMLInputElement>('import-merge').checked = true;
    updateImportConfirm();
  } catch (error) {
    showImportError(error instanceof ImportError ? error.message : `The file couldn't be read (${errorMessage(error)}).`);
  }
  els.importDialog.showModal();
  if (!els.importConfirm.hidden) els.importConfirm.focus();
}

let importBlocked = { merge: false, replace: false };

function selectedImportMode(): ImportMode {
  return byId<HTMLInputElement>('import-replace').checked ? 'replace' : 'merge';
}

function updateImportConfirm(): void {
  els.importConfirm.disabled = importBlocked[selectedImportMode()];
}

function aboutProLinkClosingDialog(): HTMLButtonElement {
  const link = aboutProLink();
  link.addEventListener('click', () => els.importDialog.close('cancel'), { capture: true });
  return link;
}

async function confirmImport(): Promise<void> {
  const parsed = pendingImport;
  pendingImport = null;
  if (!parsed) return;
  const mode = selectedImportMode();
  try {
    const plan = await importSnippets(parsed.drafts, mode);
    snippets = plan.snippets;
    render();
    const summary =
      mode === 'replace'
        ? `Imported ${plural(plan.added, 'snippet')}, replacing your previous ones`
        : `Imported: ${plan.added} added, ${plan.updated} updated${plan.unchanged ? `, ${plan.unchanged} unchanged` : ''}`;
    toast(summary);
  } catch (error) {
    toast(`Import failed: ${errorMessage(error)}`, { variant: 'danger' });
  }
}

// --- Setup ------------------------------------------------------------------------------

async function init(): Promise<void> {
  els.searchIcon.append(svgIcon(searchIcon));
  els.newButton.prepend(svgIcon(plusIcon, 'me-1'));
  els.importButton.prepend(svgIcon(uploadIcon, 'me-1'));
  els.exportButton.prepend(svgIcon(downloadIcon, 'me-1'));

  try {
    [snippets, settings, plan, usage, clipboardGranted] = await Promise.all([loadSnippets(), loadSettings(), loadPlanState(), loadUsage(), hasClipboardAccess()]);
  } catch (error) {
    showLoadError(error);
    return;
  }
  loaded = true;
  render();
  renderSettings();
  renderPro();
  renderClipboardAccess();
  onClipboardAccessChange(() => void refreshClipboardAccess());
  if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname);
    openEditor(null);
  }

  onStoreChanged((change) => {
    if (change.usage) usage = change.usage;
    if (change.snippets) {
      snippets = change.snippets;
      renderClipboardAccess();
      renderTriggerExample();
    }
    if (change.settings) {
      settings = change.settings;
      renderSettings();
    }
    if (change.plan) {
      plan = change.plan;
      renderPro();
    }
    render();
    if (editor) updateEditor(editor);
  });
}

els.newButton.addEventListener('click', () => openEditor(null));
els.getPro.addEventListener('click', () => {
  // Payments are not wired up yet; a future src/payments/ adapter takes over this button.
  if (!EARLY_ACCESS) toast("Payments aren't available in this version yet.", { variant: 'danger' });
});
for (const id of ['import-merge', 'import-replace']) byId<HTMLInputElement>(id).addEventListener('change', updateImportConfirm);
els.search.addEventListener('input', () => render());
els.sort.addEventListener('change', async () => {
  const order = els.sort.value;
  if (!isSortOrder(order)) return;
  settings = { ...settings, managerSort: order };
  render();
  try {
    settings = await saveSettings({ managerSort: order });
  } catch (error) {
    toast(`Couldn't save: ${errorMessage(error)}`, { variant: 'danger' });
  }
});
els.autocomplete.addEventListener('change', async () => {
  const on = els.autocomplete.checked;
  try {
    settings = await saveSettings({ autocomplete: on });
    toast(on ? 'Suggestions appear as you type' : 'Suggestions are off');
  } catch (error) {
    renderSettings();
    toast(`Couldn't save: ${errorMessage(error)}`, { variant: 'danger' });
  }
});
els.search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && els.search.value) {
    event.preventDefault();
    els.search.value = '';
    render();
  }
});
els.exportButton.addEventListener('click', exportSnippets);
els.importButton.addEventListener('click', () => {
  els.importFile.value = '';
  els.importFile.click();
});
els.importFile.addEventListener('change', () => {
  const file = els.importFile.files?.[0];
  if (file) void onImportFile(file);
});
els.importDialog.addEventListener('close', () => {
  if (els.importDialog.returnValue === 'import') void confirmImport();
  else pendingImport = null;
  els.importDialog.returnValue = '';
});
for (const input of triggerInputs) {
  input.addEventListener('change', async () => {
    if (!input.checked || !isTriggerMode(input.value)) return;
    try {
      settings = await saveSettings({ triggerMode: input.value });
      render();
      if (editor) updateEditor(editor);
      toast(input.value === 'immediate' ? 'Snippets now expand as you type' : 'Snippets now expand after Space, Tab or Enter');
    } catch (error) {
      renderSettings();
      toast(`Couldn't save: ${errorMessage(error)}`, { variant: 'danger' });
    }
  });
}
els.siteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void addSite();
});
els.siteInput.addEventListener('input', () => showSiteError(''));
window.addEventListener('beforeunload', (event) => {
  if (editor && isDirty(editor)) event.preventDefault();
});

function showLoadError(error: unknown): void {
  els.list.hidden = true;
  for (const button of [els.newButton, els.importButton, els.exportButton]) button.disabled = true;
  els.listAlert.replaceChildren(
    h('div', { class: 'fw-semibold', text: "Couldn't load your snippets" }),
    h('div', { text: 'Reload the page to try again.' }),
    h('div', { class: 'small mt-1 opacity-75', text: `Details: ${errorMessage(error)}` }),
  );
  els.listAlert.hidden = false;
}

init().catch(showLoadError);
