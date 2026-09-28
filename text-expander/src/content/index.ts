/**
 * Expansion engine. Declared for every page and frame because a text expander has to see
 * typing wherever it happens. Per keystroke it only checks whether the typed character can
 * end an abbreviation (a Set lookup); for the rare ones that can, it reads the few characters
 * before the caret and looks them up in a Map. Nothing typed is stored or sent anywhere.
 */

import { buildIndex, findMatch, mayCompleteAbbreviation, type AbbreviationIndex } from '../core/matcher';
import { defaultPlanState, hasFeature, type PlanState } from '../core/plan';
import { defaultSettings, findDisablingEntry, sanitizeSettings, type Settings } from '../core/settings';
import { sanitizeSnippets, type Snippet } from '../core/snippets';
import { expandTemplate, normalizeInputValue, parseFields, type FillField } from '../core/variables';
import { SETTINGS_KEY, SNIPPETS_KEY } from '../storage/keys';
import { isPlanChange, PLAN_KEYS, planStateFrom } from '../storage/plan';
import {
  editableFromEvent,
  readCaret,
  replaceBeforeCaret,
  revertExpansion,
  type CaretContext,
  type Editable,
  type UndoRecord,
} from './editable';
import { closeFillForm, fieldCaretRect, fillFormHost, openFillForm, rangeCaretRect } from './fillForm';
import { showNotice } from './notice';

type Delimiter = ' ' | 'Tab' | 'Enter';

let index: AbbreviationIndex<Snippet> = buildIndex<Snippet>([]);
let settings: Settings = defaultSettings();
let plan: PlanState = defaultPlanState();
let siteDisabled = false;
/** True while we edit, so our own input events aren't treated as typing. */
let busy = false;
/** The last expansion, revertible with an immediate Backspace. */
let lastExpansion: { record: UndoRecord; typed: string } | null = null;
/** How many storage updates this frame applied (read by the e2e test build only). */
let applied = 0;

/** This frame's host plus the hosts of every page it's embedded in (top page last). */
function pageHosts(): string[] {
  const hosts = [location.hostname];
  const ancestors = location.ancestorOrigins;
  for (let i = 0; i < (ancestors?.length ?? 0); i++) {
    try {
      hosts.push(new URL(ancestors[i] as string).hostname);
    } catch {
      // Opaque origins ("null") have no host.
    }
  }
  return hosts;
}

const hosts = pageHosts();

function applySnippets(snippets: Snippet[]): void {
  index = buildIndex(snippets);
  markApplied();
}

function applySettings(next: Settings): void {
  settings = next;
  siteDisabled = findDisablingEntry(hosts, settings.disabledSites) !== null;
  if (siteDisabled) {
    lastExpansion = null;
    closeFillForm();
  }
  markApplied();
}

function applyPlan(next: PlanState): void {
  plan = next;
  markApplied();
}

function markApplied(): void {
  // Test build only: lets the e2e test wait until storage changes reached this frame.
  if (__E2E__) document.documentElement.dataset.snippetsE2e = String(++applied);
}

function active(): boolean {
  return !siteDisabled && index.size > 0;
}

function expand(target: Editable, delimiter: Delimiter | null): boolean {
  const context = readCaret(target, index.maxLength);
  if (!context) return false;
  const match = findMatch(context.textBefore, index);
  if (!match) return false;

  // Pro: fill-in fields are asked for first; the abbreviation stays until the user confirms.
  const fields = hasFeature(plan.plan, 'fill-in-fields', plan.earlyAccess) ? parseFields(match.item.text) : [];
  if (fields.length > 0) {
    askForFields(target, context, match.abbreviation, match.item.text, fields, delimiter);
    return true;
  }
  return replaceAbbreviation(context, match.abbreviation, match.item.text, delimiter, undefined);
}

function replaceAbbreviation(
  context: CaretContext,
  abbreviation: string,
  template: string,
  delimiter: Delimiter | null,
  inputs: Record<string, string> | undefined,
): boolean {
  const singleLine = context.kind === 'field' && context.element instanceof HTMLInputElement;
  const expansion = expandTemplate(template, { now: new Date(), locale: navigator.language, singleLine, inputs });
  // The space that triggered the expansion is kept; Tab and Enter are consumed.
  const text = delimiter === ' ' ? `${expansion.text} ` : expansion.text;

  busy = true;
  try {
    const result = replaceBeforeCaret(context, abbreviation.length, text, expansion.cursor);
    if (!result.ok) {
      showNotice(`Couldn't expand ${abbreviation}`, result.message);
      return false;
    }
    lastExpansion = result.undo ? { record: result.undo, typed: delimiter === ' ' ? `${abbreviation} ` : abbreviation } : null;
    if (result.notice) showNotice(`Only part of ${abbreviation} fit`, result.notice);
    return true;
  } catch (error) {
    showNotice(`Couldn't expand ${abbreviation}`, 'This page got in the way. You can copy the snippet from the toolbar button instead.');
    console.error('Snippets: expansion failed', error);
    return false;
  } finally {
    busy = false;
  }
}

// --- Fill-in fields (Pro) ---------------------------------------------------------------

/** Where the caret was when the form opened, so it can be put back exactly there. */
type SavedCaret = { kind: 'field'; caret: number; caretKnown: boolean } | { kind: 'rich'; selection: Selection; range: Range };

function saveCaret(context: CaretContext): SavedCaret {
  if (context.kind === 'field') return { kind: 'field', caret: context.caret, caretKnown: context.caretKnown };
  const range = document.createRange();
  range.setStart(context.node, context.offset);
  return { kind: 'rich', selection: context.selection, range };
}

/** Focuses the field again with the caret where it was. False when the field is gone. */
function restoreCaret(target: Editable, saved: SavedCaret): boolean {
  if (!target.element.isConnected) return false;
  target.element.focus({ preventScroll: true });
  if (saved.kind === 'field') {
    if (saved.caretKnown && target.kind === 'field') target.element.setSelectionRange(saved.caret, saved.caret);
    return true;
  }
  saved.selection.removeAllRanges();
  saved.selection.addRange(saved.range);
  return true;
}

function askForFields(target: Editable, context: CaretContext, abbreviation: string, template: string, fields: FillField[], delimiter: Delimiter | null): void {
  const saved = saveCaret(context);
  const anchor = context.kind === 'field' ? fieldCaretRect(context.element, context.caret) : rangeCaretRect(saved.kind === 'rich' ? saved.range : document.createRange(), context.element);
  lastExpansion = null;
  openFillForm({
    abbreviation,
    fields,
    anchor,
    onSubmit: (values) => {
      if (!restoreCaret(target, saved)) return;
      // Read the field again: the page may have changed while the form was open.
      const now = readCaret(target, Math.max(index.maxLength, abbreviation.length));
      if (!now || !now.textBefore.endsWith(abbreviation)) {
        showNotice(`Couldn't expand ${abbreviation}`, 'The text before the caret changed while the form was open. Type the abbreviation again.');
        return;
      }
      const inputs = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, normalizeInputValue(value)]));
      replaceAbbreviation(now, abbreviation, template, delimiter, inputs);
    },
    onCancel: (refocus) => {
      if (!refocus || !restoreCaret(target, saved)) return;
      // The abbreviation stays. A Space that triggered the form was held back: type it now.
      if (delimiter !== ' ') return;
      const now = readCaret(target, 0);
      if (!now) return;
      busy = true;
      try {
        replaceBeforeCaret(now, 0, ' ', null);
      } finally {
        busy = false;
      }
    },
  });
}

/** True for events that come from inside our own fill-in form. */
function fromFillForm(event: Event): boolean {
  const host = fillFormHost();
  return host !== null && event.composedPath().includes(host);
}

function onInput(event: Event): void {
  if (busy || !event.isTrusted || fromFillForm(event)) return;
  lastExpansion = null;
  if (settings.triggerMode !== 'immediate' || !active()) return;
  const input = event as InputEvent;
  if (input.inputType !== 'insertText' || input.isComposing || !mayCompleteAbbreviation(index, input.data)) return;
  const target = editableFromEvent(event);
  if (target) expand(target, null);
}

function delimiterOf(event: KeyboardEvent): Delimiter | null {
  if (event.key === ' ') return ' ';
  if (event.shiftKey) return null;
  if (event.key === 'Tab') return 'Tab';
  if (event.key === 'Enter') return 'Enter';
  return null;
}

function onKeyDown(event: KeyboardEvent): void {
  if (busy || !event.isTrusted || fromFillForm(event)) return;
  const pending = lastExpansion;
  lastExpansion = null;
  if (event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === 'Backspace') {
    if (!pending || editableFromEvent(event)?.element !== pending.record.element) return;
    busy = true;
    let reverted = false;
    try {
      reverted = revertExpansion(pending.record, pending.typed);
    } catch (error) {
      console.error('Snippets: undo failed', error);
    } finally {
      busy = false;
    }
    if (reverted) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    return;
  }

  if (settings.triggerMode !== 'delimiter' || !active() || event.repeat) return;
  const delimiter = delimiterOf(event);
  if (!delimiter) return;
  const target = editableFromEvent(event);
  if (target && expand(target, delimiter)) {
    // The page must not also act on it (insert the space, move focus, submit, send...).
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function forgetExpansion(): void {
  lastExpansion = null;
}

// Capture phase on window: runs before the page's own handlers, sees events from open shadow roots.
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('input', onInput, true);
window.addEventListener('pointerdown', forgetExpansion, true);
window.addEventListener('focusout', forgetExpansion, true);
window.addEventListener('compositionstart', forgetExpansion, true);

async function init(): Promise<void> {
  const data = await chrome.storage.local.get([SNIPPETS_KEY, SETTINGS_KEY, ...PLAN_KEYS]);
  applySnippets(sanitizeSnippets(data[SNIPPETS_KEY]));
  applySettings(sanitizeSettings(data[SETTINGS_KEY]));
  applyPlan(planStateFrom(data));
}

// Edits in the manager and the popup's site toggle apply without reloading the page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (SNIPPETS_KEY in changes) applySnippets(sanitizeSnippets(changes[SNIPPETS_KEY]?.newValue));
  if (SETTINGS_KEY in changes) applySettings(sanitizeSettings(changes[SETTINGS_KEY]?.newValue));
  if (isPlanChange(changes)) {
    chrome.storage.local
      .get([...PLAN_KEYS])
      .then((data) => applyPlan(planStateFrom(data)))
      .catch(() => undefined);
  }
});

// The popup asks the top frame whether Snippets is running on this tab.
if (window === window.top) {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if ((message as { type?: unknown } | null)?.type !== 'snippets/ping') return;
    sendResponse({ running: true, disabled: siteDisabled });
  });
}

init().catch((error) => {
  // Only happens when the extension was reloaded or removed while this page stayed open.
  console.warn('Snippets: could not load snippets; reload the page to use them here.', error);
});
