import type { SelectionFormat } from '../core/convert';
import type { Settings } from '../core/settings';
import type { PageApi, SelectionResult } from '../page/index';

/**
 * Talks to page.js inside a tab. The script is injected on demand (activeTab + scripting),
 * then its functions are called with a second executeScript. Both calls throw when Chrome
 * doesn't let extensions script the page (chrome://, the Web Store, the PDF viewer...).
 */

const PAGE_SCRIPT = 'page.js';

type Result<K extends keyof PageApi> = ReturnType<PageApi[K]>;

/** Runs in the page, serialized: must stay self-contained. */
function invoke(name: string, args: unknown[]): unknown {
  const api = (globalThis as unknown as { __universalCopy?: Record<string, (...values: unknown[]) => unknown> }).__universalCopy;
  const fn = api?.[name];
  if (typeof fn !== 'function') throw new Error('Universal Copy: page script not loaded');
  return fn(...args);
}

export async function callPage<K extends keyof PageApi>(
  tabId: number,
  frameId: number,
  name: K,
  ...args: Parameters<PageApi[K]>
): Promise<Result<K>> {
  const target = { tabId, frameIds: [frameId] };
  await chrome.scripting.executeScript({ target, files: [PAGE_SCRIPT] });
  const [injection] = await chrome.scripting.executeScript({ target, func: invoke, args: [name, args] });
  if (!injection) throw new Error('No result from the page');
  const failed = (injection as { error?: unknown }).error;
  if (failed) throw new Error(String(failed));
  return injection.result as Result<K>;
}

/**
 * The keyboard shortcut doesn't say which frame holds the selection: convert it in every
 * frame we may script and prefer the focused one. Falls back to the top frame alone.
 */
export async function convertSelectionInAnyFrame(tabId: number, format: SelectionFormat, settings: Settings): Promise<SelectionResult | null> {
  try {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: [PAGE_SCRIPT] });
    const results = await chrome.scripting.executeScript({
      target,
      func: (format: string, settings: unknown) => {
        const api = (globalThis as unknown as { __universalCopy?: { convertSelection: (format: string, settings: unknown) => unknown } })
          .__universalCopy;
        return api ? { result: api.convertSelection(format, settings), focused: document.hasFocus() } : null;
      },
      args: [format, settings],
    });
    const found = results
      .map((injection) => injection.result as { result: SelectionResult; focused: boolean } | null | undefined)
      .filter((value): value is { result: SelectionResult; focused: boolean } => Boolean(value && value.result.kind !== 'empty'));
    const best = found.find((value) => value.focused) ?? found[0];
    if (best) return best.result;
  } catch {
    // Some frames can't be scripted; try the top frame alone.
  }
  try {
    return await callPage(tabId, 0, 'convertSelection', format, settings);
  } catch {
    return null;
  }
}
