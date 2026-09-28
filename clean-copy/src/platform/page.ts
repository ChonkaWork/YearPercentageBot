import type { Rule } from '../core/rules';
import type { CleanOptions } from '../core/settings';
import type { PageApi } from '../page/index';
import type { PageCleanResult } from '../page/selection';

/**
 * Talks to page.js inside a tab. The script is injected on demand (activeTab + scripting),
 * then its functions are called with a second executeScript. Both calls throw when Chrome
 * doesn't let extensions script the page (chrome://, the Web Store, the PDF viewer...).
 */

const PAGE_SCRIPT = 'page.js';

type Result<K extends keyof PageApi> = ReturnType<PageApi[K]>;

/** Runs in the page, serialized: must stay self-contained. */
function invoke(name: string, args: unknown[]): unknown {
  const api = (globalThis as unknown as { __cleanCopy?: Record<string, (...values: unknown[]) => unknown> }).__cleanCopy;
  const fn = api?.[name];
  if (typeof fn !== 'function') throw new Error('Clean Copy: page script not loaded');
  return fn(...args);
}

export async function callPage<K extends keyof PageApi>(tabId: number, frameId: number, name: K, ...args: Parameters<PageApi[K]>): Promise<Result<K>> {
  const target = { tabId, frameIds: [frameId] };
  await chrome.scripting.executeScript({ target, files: [PAGE_SCRIPT] });
  const [injection] = await chrome.scripting.executeScript({ target, func: invoke, args: [name, args] });
  if (!injection) throw new Error('No result from the page');
  const failed = (injection as { error?: unknown }).error;
  if (failed) throw new Error(String(failed));
  return injection.result as Result<K>;
}

/**
 * The keyboard shortcut doesn't say which frame holds the selection: clean it in every frame
 * we may script and prefer the focused one. Falls back to the top frame alone.
 */
export async function cleanInAnyFrame(tabId: number, options: CleanOptions, rules: Rule[] | null): Promise<PageCleanResult | null> {
  try {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: [PAGE_SCRIPT] });
    const results = await chrome.scripting.executeScript({
      target,
      func: (options: unknown, rules: unknown) => {
        const api = (globalThis as unknown as { __cleanCopy?: { clean: (options: unknown, rules: unknown) => unknown } }).__cleanCopy;
        return api ? { result: api.clean(options, rules), focused: document.hasFocus() } : null;
      },
      args: [options, rules],
    });
    const found = results
      .map((injection) => injection.result as { result: PageCleanResult; focused: boolean } | null | undefined)
      .filter((value): value is { result: PageCleanResult; focused: boolean } => Boolean(value && value.result.kind !== 'empty'));
    const best = found.find((value) => value.focused) ?? found[0];
    if (best) return best.result;
  } catch {
    // Some frames can't be scripted; try the top frame alone.
  }
  try {
    return await callPage(tabId, 0, 'clean', options, rules);
  } catch {
    return null;
  }
}
