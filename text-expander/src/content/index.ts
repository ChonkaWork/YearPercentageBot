/**
 * Expansion engine. Declared for every page and frame because a text expander has to see
 * typing wherever it happens. Per keystroke it only checks whether the typed character can
 * end an abbreviation (a Set lookup); for the rare ones that can, it reads the few characters
 * before the caret and looks them up in a Map. Nothing typed is stored or sent anywhere.
 */

import { buildIndex, findMatch, mayCompleteAbbreviation, type AbbreviationIndex } from '../core/matcher';
import { defaultSettings, findDisablingEntry, sanitizeSettings, type Settings } from '../core/settings';
import { sanitizeSnippets, type Snippet } from '../core/snippets';
import { expandTemplate } from '../core/variables';
import { SETTINGS_KEY, SNIPPETS_KEY } from '../storage/keys';
import { editableFromEvent, readCaret, replaceBeforeCaret, revertExpansion, type Editable, type UndoRecord } from './editable';
import { showNotice } from './notice';

type Delimiter = ' ' | 'Tab' | 'Enter';

let index: AbbreviationIndex<Snippet> = buildIndex<Snippet>([]);
let settings: Settings = defaultSettings();
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
  if (siteDisabled) lastExpansion = null;
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

  const singleLine = target.kind === 'field' && target.element instanceof HTMLInputElement;
  const expansion = expandTemplate(match.item.text, { now: new Date(), locale: navigator.language, singleLine });
  // The space that triggered the expansion is kept; Tab and Enter are consumed.
  const text = delimiter === ' ' ? `${expansion.text} ` : expansion.text;

  busy = true;
  try {
    const result = replaceBeforeCaret(context, match.abbreviation.length, text, expansion.cursor);
    if (!result.ok) {
      showNotice(`Couldn't expand ${match.abbreviation}`, result.message);
      return false;
    }
    lastExpansion = result.undo ? { record: result.undo, typed: delimiter === ' ' ? `${match.abbreviation} ` : match.abbreviation } : null;
    if (result.notice) showNotice(`Only part of ${match.abbreviation} fit`, result.notice);
    return true;
  } catch (error) {
    showNotice(`Couldn't expand ${match.abbreviation}`, 'This page got in the way. You can copy the snippet from the toolbar button instead.');
    console.error('Snippets: expansion failed', error);
    return false;
  } finally {
    busy = false;
  }
}

function onInput(event: Event): void {
  if (busy || !event.isTrusted) return;
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
  if (busy || !event.isTrusted) return;
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
  const data = await chrome.storage.local.get([SNIPPETS_KEY, SETTINGS_KEY]);
  applySnippets(sanitizeSnippets(data[SNIPPETS_KEY]));
  applySettings(sanitizeSettings(data[SETTINGS_KEY]));
}

// Edits in the manager and the popup's site toggle apply without reloading the page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (SNIPPETS_KEY in changes) applySnippets(sanitizeSnippets(changes[SNIPPETS_KEY]?.newValue));
  if (SETTINGS_KEY in changes) applySettings(sanitizeSettings(changes[SETTINGS_KEY]?.newValue));
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
