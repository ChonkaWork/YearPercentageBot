import type { Rule } from '../core/rules';
import type { CleanOptions } from '../core/settings';
import { cleanSelection, type PageCleanResult } from './selection';
import { showToast } from './toast';

/**
 * Entry point of page.js, injected on demand with chrome.scripting.executeScript (activeTab:
 * after a context-menu click, the shortcut or opening the popup). It only defines functions
 * in the extension's isolated world; the background and the popup call them with a second
 * executeScript. The cleanup runs here, next to the DOM: only the clean text leaves the page.
 */

const api = {
  clean(options: CleanOptions, rules: Rule[] | null): PageCleanResult {
    return cleanSelection(document, options, rules);
  },
  toast: showToast,
};

export type PageApi = typeof api;

(globalThis as unknown as { __cleanCopy: PageApi }).__cleanCopy = api;
