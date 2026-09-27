/**
 * DOM side of expansion: finding the field the user is typing in, reading the few characters
 * before the caret, replacing the abbreviation and reverting it.
 *
 * Replacement goes through `document.execCommand('insertText')` everywhere because it is the
 * only way to edit that keeps the page's native undo (Ctrl/Cmd+Z) and fires real
 * beforeinput/input events, so React/Vue-controlled fields and rich editors update their
 * state. When the command isn't available, inputs fall back to `setRangeText` plus an
 * `input` event, and email inputs (no caret API) to the native value setter.
 */

import { isExpandableField, NO_SELECTION_API_TYPES } from '../core/fields';

export type Editable =
  | { kind: 'field'; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'rich'; element: HTMLElement; root: Document | ShadowRoot };

/**
 * The element that receives the typing. Events from open shadow roots are retargeted to the
 * host, so the real target comes from `composedPath()[0]`.
 */
export function editableFromEvent(event: Event): Editable | null {
  const target = event.composedPath()[0];
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const expandable = isExpandableField({
      tag: target.localName,
      type: target instanceof HTMLInputElement ? target.type : undefined,
      autocomplete: target.getAttribute('autocomplete'),
      readOnly: target.readOnly,
      disabled: target.disabled,
    });
    return expandable ? { kind: 'field', element: target } : null;
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    const root = target.getRootNode();
    if (root instanceof Document || root instanceof ShadowRoot) return { kind: 'rich', element: target, root };
  }
  return null;
}

export interface FieldCaret {
  kind: 'field';
  element: HTMLInputElement | HTMLTextAreaElement;
  caret: number;
  /** False for email inputs: they don't expose the caret, so the end of the value is assumed. */
  caretKnown: boolean;
  textBefore: string;
}

export interface RichCaret {
  kind: 'rich';
  element: HTMLElement;
  selection: Selection;
  node: Text;
  offset: number;
  textBefore: string;
}

export type CaretContext = FieldCaret | RichCaret;

function selectionFor(root: Document | ShadowRoot): Selection | null {
  // Chrome-only, but this is a Chrome extension: the selection as seen inside the shadow tree.
  if (root instanceof ShadowRoot) {
    const shadowSelection = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
    if (shadowSelection) return shadowSelection;
  }
  return document.getSelection();
}

/** Reads at most `maxLength + 1` characters before a collapsed caret. */
export function readCaret(target: Editable, maxLength: number): CaretContext | null {
  const window = maxLength + 1;
  if (target.kind === 'field') {
    const element = target.element;
    let start: number | null = null;
    let end: number | null = null;
    if (!(element instanceof HTMLInputElement && NO_SELECTION_API_TYPES.has(element.type))) {
      start = element.selectionStart;
      end = element.selectionEnd;
    }
    const value = element.value;
    if (start === null || end === null) {
      return { kind: 'field', element, caret: value.length, caretKnown: false, textBefore: value.slice(-window) };
    }
    if (start !== end) return null;
    return { kind: 'field', element, caret: end, caretKnown: true, textBefore: value.slice(Math.max(0, end - window), end) };
  }

  const selection = selectionFor(target.root);
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  let node = selection.focusNode;
  let offset = selection.focusOffset;
  if (node && node.nodeType === Node.ELEMENT_NODE) {
    // Caret between elements, e.g. right after a text node at the end of a paragraph.
    const previous = node.childNodes[offset - 1];
    if (!previous || previous.nodeType !== Node.TEXT_NODE) return null;
    node = previous;
    offset = (previous as Text).length;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !target.element.contains(node)) return null;
  const text = node as Text;
  return {
    kind: 'rich',
    element: target.element,
    selection,
    node: text,
    offset,
    textBefore: text.data.slice(Math.max(0, offset - window), offset),
  };
}

// --- Undo records -----------------------------------------------------------------------

export type UndoRecord =
  | {
      kind: 'field';
      element: HTMLInputElement | HTMLTextAreaElement;
      start: number;
      inserted: string;
      /** Caret right after the expansion (or null when the caret isn't observable). */
      caret: number | null;
    }
  | {
      kind: 'rich';
      element: HTMLElement;
      selection: Selection;
      /** Live, collapsed range at the caret right after the expansion. */
      caret: Range;
      /** The text that was replaced; the native undo step has to bring back exactly this. */
      abbreviation: string;
    };

export type ReplaceResult =
  | { ok: true; undo: UndoRecord | null; /** Shown to the user, e.g. when a length limit cut the text. */ notice?: string }
  | { ok: false; message: string };

// --- Editing ----------------------------------------------------------------------------

function insertText(text: string): boolean {
  // Test build only: lets the e2e test exercise the fallbacks, which Chrome never needs.
  if (__E2E__ && document.documentElement.hasAttribute('data-snippets-e2e-no-exec')) return false;
  try {
    return document.execCommand('insertText', false, text);
  } catch {
    return false;
  }
}

/** Sets `value` past framework setters (React tracks values assigned through `element.value`). */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function dispatchInput(element: HTMLElement, data: string): void {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data }));
}

/**
 * Replaces the `length` characters before the caret with `text` and puts the caret at
 * `cursor` (index into `text`) or after the text.
 */
export function replaceBeforeCaret(context: CaretContext, length: number, text: string, cursor: number | null): ReplaceResult {
  return context.kind === 'field' ? replaceInField(context, length, text, cursor) : replaceInRich(context, length, text, cursor);
}

function replaceInField(context: FieldCaret, length: number, text: string, cursor: number | null): ReplaceResult {
  const { element, caret } = context;
  const start = caret - length;
  const before = element.value;

  if (!context.caretKnown) {
    // Email inputs: no selection API, so no execCommand either. Replace at the end.
    setNativeValue(element, before.slice(0, start) + text);
    dispatchInput(element, text);
    const inserted = element.value.slice(start) === text;
    return inserted ? { ok: true, undo: { kind: 'field', element, start, inserted: text, caret: null } } : blocked(element, before);
  }

  element.setSelectionRange(start, caret);
  if (!insertText(text)) {
    element.setRangeText(text, start, caret, 'end');
    dispatchInput(element, text);
  }
  if (element.value.slice(start, start + text.length) !== text) return blocked(element, before);
  const position = start + (cursor ?? text.length);
  if (position !== start + text.length) element.setSelectionRange(position, position);
  return { ok: true, undo: { kind: 'field', element, start, inserted: text, caret: position } };
}

function blocked(element: HTMLInputElement | HTMLTextAreaElement, before: string): ReplaceResult {
  if (element.value === before) return { ok: false, message: "This field didn't accept the text." };
  // Changed, but not into what we inserted: a length limit, or the page reformatting the value.
  if (element.maxLength > 0 && element.value.length >= element.maxLength) {
    return { ok: true, undo: null, notice: `This field takes ${element.maxLength} characters at most.` };
  }
  return { ok: true, undo: null };
}

/**
 * True when the text right before the caret ends with the last line of `text`. Rich editors
 * may apply an insertion asynchronously or re-render it; then we don't touch the caret.
 */
function caretFollows(element: HTMLElement, selection: Selection, text: string): boolean {
  const focusNode = selection.focusNode;
  if (!selection.isCollapsed || !focusNode || !element.contains(focusNode)) return false;
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  if (!lastLine) return true;
  const before = document.createRange();
  before.setStart(element, 0);
  before.setEnd(focusNode, selection.focusOffset);
  // Editors keep trailing and repeated spaces visible as non-breaking spaces.
  const normalize = (value: string) => value.replace(/\u00a0/g, ' ');
  return normalize(before.toString()).endsWith(normalize(lastLine));
}

function countGraphemes(text: string): number {
  let count = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) count++;
  return count;
}

function replaceInRich(context: RichCaret, length: number, text: string, cursor: number | null): ReplaceResult {
  const { selection, node, offset, element } = context;
  const abbreviation = node.data.slice(offset - length, offset);
  const range = document.createRange();
  range.setStart(node, offset - length);
  range.setEnd(node, offset);
  selection.removeAllRanges();
  selection.addRange(range);

  const native = insertText(text);
  if (!native) {
    // execCommand refused (rare): edit the DOM directly and tell the page.
    try {
      range.deleteContents();
      const fragment = document.createDocumentFragment();
      text.split('\n').forEach((line, index) => {
        if (index > 0) fragment.append(document.createElement('br'));
        if (line) fragment.append(document.createTextNode(line));
      });
      const last = fragment.lastChild;
      range.insertNode(fragment);
      if (last) {
        const after = document.createRange();
        after.setStartAfter(last);
        selection.removeAllRanges();
        selection.addRange(after);
      }
      dispatchInput(element, text);
    } catch {
      return { ok: false, message: "This editor didn't accept the text." };
    }
  }

  if (!caretFollows(element, selection, text)) return { ok: true, undo: null };
  if (cursor !== null && cursor < text.length) {
    const steps = countGraphemes(text.slice(cursor));
    for (let step = 0; step < steps; step++) selection.modify('move', 'backward', 'character');
  }
  // Undo goes through the editor's native undo step, which only exists for execCommand edits.
  if (!native) return { ok: true, undo: null };
  const caret = selection.getRangeAt(0).cloneRange();
  return { ok: true, undo: { kind: 'rich', element, selection, caret, abbreviation } };
}

/**
 * Backspace right after an expansion: puts `typed` (the abbreviation, plus the space that
 * triggered it) back. Only when the field still looks exactly like right after the
 * expansion; otherwise returns false and Backspace does its normal thing.
 */
export function revertExpansion(record: UndoRecord, typed: string): boolean {
  if (record.kind === 'field') {
    const { element, start, inserted } = record;
    if (element.value.slice(start, start + inserted.length) !== inserted) return false;
    if (record.caret === null) {
      if (element.value.length !== start + inserted.length) return false;
      setNativeValue(element, element.value.slice(0, start) + typed);
      dispatchInput(element, typed);
      return true;
    }
    if (element.selectionStart !== record.caret || element.selectionEnd !== record.caret) return false;
    element.setSelectionRange(start, start + inserted.length);
    if (!insertText(typed)) {
      element.setRangeText(typed, start, start + inserted.length, 'end');
      dispatchInput(element, typed);
    }
    return true;
  }

  // Rich editors restructure the DOM around inserted line breaks, so instead of locating the
  // inserted text we take back the native undo step of our own execCommand. It restores the
  // selection over the abbreviation; if it doesn't, the step wasn't ours and is redone.
  const { selection, caret, abbreviation } = record;
  if (selection.rangeCount === 0 || !selection.isCollapsed) return false;
  if (selection.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START, caret) !== 0) return false;
  if (!document.execCommand('undo')) return false;
  if (selection.toString() !== abbreviation) {
    document.execCommand('redo');
    return false;
  }
  selection.collapseToEnd();
  const rest = typed.slice(abbreviation.length);
  if (rest) insertText(rest);
  return true;
}
