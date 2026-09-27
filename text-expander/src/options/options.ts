import alertIcon from 'bootstrap-icons/icons/exclamation-triangle-fill.svg';
import checkIcon from 'bootstrap-icons/icons/check-circle-fill.svg';
import errorIcon from 'bootstrap-icons/icons/x-circle-fill.svg';
import keyboardIcon from 'bootstrap-icons/icons/keyboard.svg';
import pencilIcon from 'bootstrap-icons/icons/pencil.svg';
import plusIcon from 'bootstrap-icons/icons/plus-lg.svg';
import searchIcon from 'bootstrap-icons/icons/search.svg';
import trashIcon from 'bootstrap-icons/icons/trash3.svg';
import uploadIcon from 'bootstrap-icons/icons/upload.svg';
import downloadIcon from 'bootstrap-icons/icons/download.svg';
import {
  buildExport,
  exportFileName,
  ImportError,
  parseImport,
  planImport,
  type ImportMode,
  type ParsedImport,
} from '../core/importExport';
import { buildIndex, findAllShadowed, findShadowing } from '../core/matcher';
import { defaultSettings, isTriggerMode, normalizeHostname, type Settings } from '../core/settings';
import {
  hasErrors,
  lacksPrefixSymbol,
  normalizeDraft,
  searchSnippets,
  validateDraft,
  type FieldErrors,
  type Snippet,
  type SnippetDraft,
  type SnippetField,
} from '../core/snippets';
import { expandTemplate, hasVariables, VARIABLE_HELP } from '../core/variables';
import {
  deleteSnippet,
  importSnippets,
  loadSettings,
  loadSnippets,
  onStoreChanged,
  restoreSnippet,
  saveSettings,
  saveSnippet,
  SnippetValidationError,
} from '../storage/store';
import { byId, h } from '../ui/dom';
import { svgIcon } from '../ui/icons';

const els = {
  count: byId<HTMLSpanElement>('count'),
  importButton: byId<HTMLButtonElement>('import'),
  exportButton: byId<HTMLButtonElement>('export'),
  newButton: byId<HTMLButtonElement>('new'),
  searchIcon: byId<HTMLSpanElement>('search-icon'),
  search: byId<HTMLInputElement>('search'),
  listAlert: byId<HTMLDivElement>('list-alert'),
  list: byId<HTMLUListElement>('list'),
  empty: byId<HTMLDivElement>('empty'),
  sites: byId<HTMLUListElement>('sites'),
  siteForm: byId<HTMLFormElement>('site-form'),
  siteInput: byId<HTMLInputElement>('site-input'),
  siteError: byId<HTMLDivElement>('site-error'),
  variables: byId<HTMLDListElement>('variables'),
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
let loaded = false;
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

// --- Editor -----------------------------------------------------------------------------

interface Editor {
  id: string | null;
  element: HTMLLIElement;
  inputs: Record<SnippetField, HTMLInputElement | HTMLTextAreaElement>;
  feedback: Record<SnippetField, HTMLDivElement>;
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
  });
}

function isDirty(current: Editor): boolean {
  return JSON.stringify(draftOf(current)) !== current.initial;
}

function createEditor(snippet: Snippet | null): Editor {
  const field = (id: SnippetField, labelText: string, control: HTMLInputElement | HTMLTextAreaElement, help?: string, optional = false) => {
    control.id = `editor-${id}`;
    control.classList.add('form-control');
    const feedback = h('div', { class: 'invalid-feedback', attrs: { id: `editor-${id}-feedback` } });
    const describedBy = [`editor-${id}-feedback`];
    const helpElement = help ? h('div', { class: 'form-text', text: help, attrs: { id: `editor-${id}-help` } }) : null;
    if (helpElement) describedBy.push(helpElement.id);
    control.setAttribute('aria-describedby', describedBy.join(' '));
    const label = h('label', { class: 'form-label', attrs: { for: control.id } }, labelText, optional && h('span', { class: 'text-body-secondary fw-normal', text: ' (optional)' }));
    return { wrapper: [label, control, feedback, helpElement] as const, feedback };
  };

  const abbreviation = h('input', {
    class: 'font-mono',
    attrs: { type: 'text', placeholder: ';sig', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' },
  });
  const label = h('input', { attrs: { type: 'text', placeholder: 'Email signature', autocomplete: 'off' } });
  const text = h('textarea', { attrs: { rows: '5', placeholder: 'Best regards,\nAlex', spellcheck: 'true' } });
  abbreviation.value = snippet?.abbreviation ?? '';
  label.value = snippet?.label ?? '';
  text.value = snippet?.text ?? '';

  const abbreviationField = field('abbreviation', 'Abbreviation', abbreviation, 'No spaces. A symbol like ; in front keeps it from firing in normal words.');
  const labelField = field('label', 'Label', label, undefined, true);
  const textField = field('text', 'Text', text);

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
      h('div', { class: 'span-all' }, ...textField.wrapper, variableBar),
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
    inputs: { abbreviation, label, text },
    feedback: { abbreviation: abbreviationField.feedback, label: labelField.feedback, text: textField.feedback },
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

function showFieldErrors(current: Editor, errors: FieldErrors): void {
  for (const name of ['abbreviation', 'label', 'text'] as const) {
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
  return warnings;
}

function updateEditor(current: Editor): void {
  const draft = draftOf(current);
  if (current.submitted) showFieldErrors(current, validateDraft(draft, othersThan(current.id)));

  const warnings = warningsFor(draft, current.id);
  current.warnings.replaceChildren(
    ...warnings.map((warning) => h('div', { class: 'd-flex gap-2' }, svgIcon(alertIcon, 'mt-1'), h('span', { text: warning }))),
  );
  current.warnings.hidden = warnings.length === 0;

  const showPreview = hasVariables(draft.text);
  current.preview.hidden = !showPreview;
  if (showPreview) {
    const expansion = expandTemplate(draft.text, { now: new Date(), locale: navigator.language });
    const parts: Node[] = [];
    if (expansion.cursor === null) {
      parts.push(document.createTextNode(expansion.text));
    } else {
      parts.push(
        document.createTextNode(expansion.text.slice(0, expansion.cursor)),
        h('span', { class: 'preview-caret', attrs: { title: 'Caret ends here', 'aria-label': 'caret' } }),
        document.createTextNode(expansion.text.slice(expansion.cursor)),
      );
    }
    current.previewBody.replaceChildren(...parts);
  }
}

function openEditor(snippet: Snippet | null): void {
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
    const first = (['abbreviation', 'label', 'text'] as const).find((name) => errors[name]);
    if (first) current.inputs[first].focus();
    return;
  }
  current.save.disabled = true;
  try {
    const result = await saveSnippet(draft, current.id);
    snippets = result.snippets;
    highlightId = result.snippet.id;
    closeEditor(result.snippet.id);
    toast(current.id ? `Saved ${result.snippet.abbreviation}` : `Created ${result.snippet.abbreviation}`);
  } catch (error) {
    if (error instanceof SnippetValidationError) {
      showFieldErrors(current, error.errors);
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
  const main = h(
    'div',
    { class: 'snippet-main', on: { click: () => openEditor(snippet) } },
    head,
    // Blank lines collapsed so the two preview lines show content.
    h('div', { class: 'snippet-text', text: snippet.text.replace(/\n\s*\n/g, '\n') }),
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
  } else {
    els.empty.replaceChildren(
      svgIcon(searchIcon, 'empty-icon'),
      h('p', { text: `No snippets match "${query}".` }),
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

  els.count.textContent = String(snippets.length);
  els.count.hidden = false;
  els.exportButton.disabled = snippets.length === 0;
  const visible = searchSnippets(snippets, els.search.value);
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

function renderVariables(): void {
  const now = new Date();
  els.variables.replaceChildren(
    ...VARIABLE_HELP.flatMap((variable) => {
      const example = variable.token === '{cursor}' ? '' : expandTemplate(variable.token, { now, locale: navigator.language }).text;
      return [
        h('dt', {}, h('code', { text: variable.token })),
        h('dd', {}, variable.description, example && h('span', { class: 'text-body-secondary', text: ` · ${example}` })),
      ];
    }),
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
    const merge = planImport(snippets, parsed.drafts, 'merge', () => '', 0);
    const parts: string[] = [];
    if (merge.added) parts.push(`adds ${plural(merge.added, 'new snippet')}`);
    if (merge.updated) parts.push(`updates ${merge.updated} with the same abbreviation`);
    if (merge.unchanged) parts.push(`${merge.unchanged} already up to date`);
    const sentence = parts.join(', ');
    els.importMergeHelp.textContent = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
    els.importReplaceHelp.textContent =
      snippets.length > 0 ? `Your ${plural(snippets.length, 'current snippet')} will be deleted first.` : 'You have no snippets yet.';
    els.importReplaceHelp.classList.toggle('text-danger-emphasis', snippets.length > 0);
    byId<HTMLInputElement>('import-merge').checked = true;
  } catch (error) {
    showImportError(error instanceof ImportError ? error.message : `The file couldn't be read (${errorMessage(error)}).`);
  }
  els.importDialog.showModal();
  if (!els.importConfirm.hidden) els.importConfirm.focus();
}

async function confirmImport(): Promise<void> {
  const parsed = pendingImport;
  pendingImport = null;
  if (!parsed) return;
  const mode: ImportMode = byId<HTMLInputElement>('import-replace').checked ? 'replace' : 'merge';
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
  renderVariables();

  try {
    [snippets, settings] = await Promise.all([loadSnippets(), loadSettings()]);
  } catch (error) {
    showLoadError(error);
    return;
  }
  loaded = true;
  render();
  renderSettings();
  if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname);
    openEditor(null);
  }

  onStoreChanged((change) => {
    if (change.snippets) snippets = change.snippets;
    if (change.settings) {
      settings = change.settings;
      renderSettings();
    }
    render();
    if (editor) updateEditor(editor);
  });
}

els.newButton.addEventListener('click', () => openEditor(null));
els.search.addEventListener('input', () => render());
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
