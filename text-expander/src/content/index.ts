/**
 * Expansion engine. Declared for every page and frame because a text expander has to see
 * typing wherever it happens. Per keystroke it only checks whether the typed character can
 * end an abbreviation (a Set lookup); for the rare ones that can, it reads the few characters
 * before the caret and looks them up in a Map. Suggestions work the same way: only after a
 * trigger character (the symbol abbreviations start with, like `;`) does it read the current
 * word, at most 42 characters, until the word ends. Nothing typed is stored or sent anywhere.
 */

import { buildIndex, findMatch, mayCompleteAbbreviation, type AbbreviationIndex } from '../core/matcher';
import { defaultPlanState, hasFeature, type PlanState } from '../core/plan';
import { previewParts, previewPlainText } from '../core/preview';
import { defaultSettings, findDisablingEntry, sanitizeSettings, type Settings } from '../core/settings';
import { sanitizeSnippets, type Snippet } from '../core/snippets';
import { hasTrigger, MAX_QUERY, queryCandidates, rankSuggestions, triggerChars, type QueryCandidate } from '../core/suggest';
import { sanitizeUsage, type UsageMap } from '../core/usage';
import { expandTemplate, normalizeInputValue, parseFields, usesClipboard, type FillField } from '../core/variables';
import { SETTINGS_KEY, SNIPPETS_KEY, USAGE_KEY } from '../storage/keys';
import { isPlanChange, PLAN_KEYS, planStateFrom } from '../storage/plan';
import { reportUsage } from '../storage/usage';
import { fieldCaretRect, rangeCaretRect } from './caret';
import { readClipboardText } from './clipboard';
import {
  editableFromEvent,
  readCaret,
  replaceBeforeCaret,
  revertExpansion,
  type CaretContext,
  type Editable,
  type UndoRecord,
} from './editable';
import { closeFillForm, fillFormHost, openFillForm } from './fillForm';
import { showNotice } from './notice';
import * as list from './suggestions';

type Delimiter = ' ' | 'Tab' | 'Enter';

let snippets: Snippet[] = [];
let index: AbbreviationIndex<Snippet> = buildIndex<Snippet>([]);
/** First characters of symbol-prefixed abbreviations: typing one may start a suggestion query. */
let triggers: ReadonlySet<string> = new Set();
let settings: Settings = defaultSettings();
let plan: PlanState = defaultPlanState();
/** Usage stats as stored; parsed only when suggestions need them. */
let usageRaw: unknown;
let usageParsed: UsageMap | null = null;
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

function applySnippets(next: Snippet[]): void {
  snippets = next;
  index = buildIndex(next);
  triggers = triggerChars(next.map((snippet) => snippet.abbreviation));
  closeSuggestions();
  markApplied();
}

function applySettings(next: Settings): void {
  settings = next;
  siteDisabled = findDisablingEntry(hosts, settings.disabledSites) !== null;
  if (siteDisabled) {
    lastExpansion = null;
    closeFillForm();
  }
  if (siteDisabled || !settings.autocomplete) closeSuggestions();
  markApplied();
}

function applyPlan(next: PlanState): void {
  plan = next;
  closeSuggestions();
  markApplied();
}

function applyUsage(raw: unknown): void {
  usageRaw = raw;
  usageParsed = null;
}

function usage(): UsageMap {
  usageParsed ??= sanitizeUsage(usageRaw);
  return usageParsed;
}

function markApplied(): void {
  // Test build only: lets the e2e test wait until storage changes reached this frame.
  if (__E2E__) document.documentElement.dataset.snippetsE2e = String(++applied);
}

function active(): boolean {
  return !siteDisabled && index.size > 0;
}

function fillInFields(snippet: Snippet): FillField[] {
  return hasFeature(plan.plan, 'fill-in-fields', plan.earlyAccess) ? parseFields(snippet.text) : [];
}

function expand(target: Editable, delimiter: Delimiter | null): boolean {
  const context = readCaret(target, index.maxLength);
  if (!context) return false;
  const match = findMatch(context.textBefore, index);
  if (!match) return false;
  armed = null;
  closeSuggestions();
  return insertSnippet(target, context, match.abbreviation, match.item, delimiter);
}

/**
 * Replaces `typed` (an abbreviation, or the start of one picked from the suggestions) right
 * before the caret with the snippet. Pro: fill-in fields are asked for first; the typed text
 * stays until the user confirms.
 */
function insertSnippet(target: Editable, context: CaretContext, typed: string, snippet: Snippet, delimiter: Delimiter | null): boolean {
  const fields = fillInFields(snippet);
  if (fields.length > 0) {
    askForFields(target, context, typed, snippet, fields, delimiter);
    return true;
  }
  return replaceAbbreviation(context, typed, snippet, delimiter, undefined);
}

function replaceAbbreviation(
  context: CaretContext,
  abbreviation: string,
  snippet: Snippet,
  delimiter: Delimiter | null,
  inputs: Record<string, string> | undefined,
): boolean {
  const singleLine = context.kind === 'field' && context.element instanceof HTMLInputElement;
  busy = true;
  try {
    // Read only when the snippet asks for it, and only now; the field has focus here.
    const clipboard = usesClipboard(snippet.text) ? readClipboardText() : undefined;
    const expansion = expandTemplate(snippet.text, { now: new Date(), locale: navigator.language, singleLine, inputs, clipboard });
    // The space that triggered the expansion is kept; Tab and Enter are consumed.
    const text = delimiter === ' ' ? `${expansion.text} ` : expansion.text;
    const result = replaceBeforeCaret(context, abbreviation.length, text, expansion.cursor);
    if (!result.ok) {
      showNotice(`Couldn't expand ${abbreviation}`, result.message);
      return false;
    }
    lastExpansion = result.undo ? { record: result.undo, typed: delimiter === ' ' ? `${abbreviation} ` : abbreviation } : null;
    if (result.notice) showNotice(`Only part of ${abbreviation} fit`, result.notice);
    reportUsage(snippet.id);
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

function askForFields(target: Editable, context: CaretContext, abbreviation: string, snippet: Snippet, fields: FillField[], delimiter: Delimiter | null): void {
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
      replaceAbbreviation(now, abbreviation, snippet, delimiter, inputs);
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

// --- Suggestions --------------------------------------------------------------------------

/** Where a query starts: an offset in the field's value, or a point in a text node. */
interface QueryStart {
  element: Element;
  node: Text | null;
  offset: number;
}

interface OpenSuggestions {
  target: Editable;
  query: string;
  start: QueryStart;
  items: Snippet[];
}

/** The element where a trigger character was typed; checked on every keystroke until the word ends. */
let armed: Element | null = null;
let suggestions: OpenSuggestions | null = null;
/** Closed with Esc: stays closed for the rest of that word. */
let dismissed: QueryStart | null = null;
/** Where the open list is anchored (the start of the query). */
let lastAnchor: DOMRect | null = null;

function sameStart(a: QueryStart | null, b: QueryStart): boolean {
  return !!a && a.element === b.element && a.node === b.node && a.offset === b.offset;
}

function closeSuggestions(): void {
  suggestions = null;
  list.closeSuggestions();
}

function queryStart(context: CaretContext, query: QueryCandidate): QueryStart {
  const length = query.text.length;
  return context.kind === 'field'
    ? { element: context.element, node: null, offset: context.caret - length }
    : { element: context.element, node: context.node, offset: context.offset - length };
}

function anchorFor(start: QueryStart): DOMRect {
  const element = start.element as HTMLElement;
  if (!start.node) return fieldCaretRect(element as HTMLInputElement | HTMLTextAreaElement, start.offset);
  const range = document.createRange();
  range.setStart(start.node, Math.min(start.offset, start.node.length));
  return rangeCaretRect(range, element);
}

/** Called for text typed or deleted while a query may be in progress. */
function updateSuggestions(event: Event, input: InputEvent): void {
  if (!settings.autocomplete || triggers.size === 0) return;
  const typing = input.inputType === 'insertText' && !input.isComposing;
  const deleting = input.inputType.startsWith('delete');
  // Fast path: most keystrokes aren't part of a query.
  const triggerTyped = typing && hasTrigger(input.data, triggers);
  if (!triggerTyped && armed === null && suggestions === null) return;
  const target = typing || deleting ? editableFromEvent(event) : null;
  if (!target) {
    armed = null;
    closeSuggestions();
    return;
  }
  if (!triggerTyped && armed !== target.element && suggestions?.target.element !== target.element) {
    closeSuggestions();
    return;
  }
  refreshSuggestions(target);
}

function refreshSuggestions(target: Editable): void {
  const context = readCaret(target, MAX_QUERY + 1);
  if (!context) {
    armed = null;
    closeSuggestions();
    return;
  }
  // readCaret returns at most MAX_QUERY + 2 characters; fewer means the start of the field.
  const complete = context.textBefore.length < MAX_QUERY + 2;
  const candidates = queryCandidates(context.textBefore, triggers, complete);
  if (candidates.length === 0) {
    // The word has no trigger character any more: stop checking until the next one. A list
    // closed with Esc may open again for the next word.
    armed = null;
    dismissed = null;
    closeSuggestions();
    return;
  }
  armed = target.element;
  const stats = usage();
  for (const query of candidates) {
    const ranked = rankSuggestions(snippets, query, stats);
    if (ranked.length === 0) continue;
    const start = queryStart(context, query);
    if (sameStart(dismissed, start)) break;
    dismissed = null;
    openSuggestions(target, query.text, start, ranked.map((entry) => entry.item));
    return;
  }
  closeSuggestions();
}

function openSuggestions(target: Editable, query: string, start: QueryStart, items: Snippet[]): void {
  const previous = suggestions;
  const sameQueryStart = previous !== null && sameStart(previous.start, start);
  // Keep the highlighted snippet highlighted while the list narrows.
  const highlighted = sameQueryStart ? previous.items[list.activeIndex()] : undefined;
  const activeIndex = highlighted ? Math.max(0, items.indexOf(highlighted)) : 0;
  suggestions = { target, query, start, items };
  const fields = hasFeature(plan.plan, 'fill-in-fields', plan.earlyAccess);
  const now = new Date();
  list.showSuggestions({
    query,
    items: items.map((snippet) => {
      const parts = previewParts(snippet.text, { now, locale: navigator.language, fields, oneLine: true, max: 90 });
      return { abbreviation: snippet.abbreviation, label: snippet.label, parts, plain: previewPlainText(parts) };
    }),
    active: activeIndex,
    // The list stays where the query started, so it doesn't jump while typing.
    anchor: sameQueryStart && lastAnchor ? lastAnchor : (lastAnchor = anchorFor(start)),
    onPick: (picked) => acceptSuggestion(picked),
  });
}

function acceptSuggestion(picked = list.activeIndex()): void {
  const current = suggestions;
  const snippet = current?.items[picked];
  closeSuggestions();
  armed = null;
  if (!current || !snippet) return;
  const context = readCaret(current.target, Math.max(MAX_QUERY + 1, current.query.length));
  // Only if the text before the caret is still exactly what the list was made for.
  if (!context || !context.textBefore.endsWith(current.query)) return;
  insertSnippet(current.target, context, current.query, snippet, null);
}

function consume(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** Keys for the open list. Returns true when the key was ours (and the page mustn't see it). */
function onSuggestionKey(event: KeyboardEvent): boolean {
  const current = suggestions;
  if (!current || event.isComposing || event.keyCode === 229 || MODIFIER_KEYS.has(event.key)) return false;
  // Never take a key for a list the user can't see (a page may remove foreign elements).
  if (!list.suggestionsHost()?.isConnected) {
    closeSuggestions();
    return false;
  }
  if (editableFromEvent(event)?.element !== current.target.element || event.ctrlKey || event.metaKey || event.altKey) {
    closeSuggestions();
    return false;
  }
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      consume(event);
      list.moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return true;
    case 'Enter':
    case 'Tab':
      if (event.shiftKey) {
        closeSuggestions();
        return false;
      }
      consume(event);
      acceptSuggestion();
      return true;
    case 'Escape':
      consume(event);
      dismissed = current.start;
      closeSuggestions();
      return true;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'Home':
    case 'End':
    case 'PageUp':
    case 'PageDown':
      closeSuggestions();
      return false;
    default:
      return false;
  }
}

let repositionFrame = 0;
function onViewportChange(event: Event): void {
  if (!suggestions || repositionFrame) return;
  if (event.type === 'scroll' && event.composedPath().includes(list.suggestionsHost() as EventTarget)) return;
  repositionFrame = requestAnimationFrame(() => {
    repositionFrame = 0;
    if (!suggestions) return;
    if (!suggestions.target.element.isConnected) {
      closeSuggestions();
      return;
    }
    lastAnchor = anchorFor(suggestions.start);
    list.reposition(lastAnchor);
  });
}

// --- Events -------------------------------------------------------------------------------

/** True for events that come from inside our own fill-in form or suggestion list. */
function fromOwnUi(event: Event): boolean {
  const path = event.composedPath();
  const form = fillFormHost();
  const suggest = list.suggestionsHost();
  return (form !== null && path.includes(form)) || (suggest !== null && path.includes(suggest));
}

function onInput(event: Event): void {
  if (busy || !event.isTrusted || fromOwnUi(event)) return;
  lastExpansion = null;
  if (!active()) return;
  const input = event as InputEvent;
  if (settings.triggerMode === 'immediate' && input.inputType === 'insertText' && !input.isComposing && mayCompleteAbbreviation(index, input.data)) {
    const target = editableFromEvent(event);
    if (target && expand(target, null)) return;
  }
  updateSuggestions(event, input);
}

function delimiterOf(event: KeyboardEvent): Delimiter | null {
  if (event.key === ' ') return ' ';
  if (event.shiftKey) return null;
  if (event.key === 'Tab') return 'Tab';
  if (event.key === 'Enter') return 'Enter';
  return null;
}

function onKeyDown(event: KeyboardEvent): void {
  if (busy || !event.isTrusted || fromOwnUi(event)) return;
  // The list only takes ↑/↓, Tab, Enter and Esc, and only while it's showing.
  if (suggestions && onSuggestionKey(event)) return;
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
    if (reverted) consume(event);
    return;
  }

  if (settings.triggerMode !== 'delimiter' || !active() || event.repeat) return;
  const delimiter = delimiterOf(event);
  if (!delimiter) return;
  const target = editableFromEvent(event);
  if (target && expand(target, delimiter)) {
    // The page must not also act on it (insert the space, move focus, submit, send...).
    consume(event);
  }
}

function onPointerDown(event: Event): void {
  lastExpansion = null;
  if (suggestions && !fromOwnUi(event)) closeSuggestions();
}

function onFocusOut(event: FocusEvent): void {
  lastExpansion = null;
  if (suggestions && event.composedPath()[0] === suggestions.target.element) closeSuggestions();
}

function forgetExpansion(): void {
  lastExpansion = null;
  armed = null;
  closeSuggestions();
}

// Capture phase on window: runs before the page's own handlers, sees events from open shadow roots.
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('input', onInput, true);
window.addEventListener('pointerdown', onPointerDown, true);
window.addEventListener('focusout', onFocusOut, true);
window.addEventListener('compositionstart', forgetExpansion, true);
window.addEventListener('blur', () => closeSuggestions());
window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
window.addEventListener('resize', onViewportChange, { passive: true });

async function init(): Promise<void> {
  const data = await chrome.storage.local.get([SNIPPETS_KEY, SETTINGS_KEY, USAGE_KEY, ...PLAN_KEYS]);
  applyUsage(data[USAGE_KEY]);
  applySnippets(sanitizeSnippets(data[SNIPPETS_KEY]));
  applySettings(sanitizeSettings(data[SETTINGS_KEY]));
  applyPlan(planStateFrom(data));
}

// Edits in the manager and the popup's site toggle apply without reloading the page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (USAGE_KEY in changes) applyUsage(changes[USAGE_KEY]?.newValue);
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
