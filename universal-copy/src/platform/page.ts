import type { SelectionFormat } from '../core/convert';
import type { Settings } from '../core/settings';
import type { ClipResult, PageApi, PageInfo, SelectionResult } from '../page/index';

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
 * The keyboard shortcuts don't say which frame holds the selection: convert it in every
 * frame we may script and prefer the focused one. Falls back to the top frame alone.
 */
export async function convertSelectionInAnyFrame(tabId: number, format: SelectionFormat, settings: Settings): Promise<SelectionResult | null> {
  return inAnyFrame(tabId, 'convertSelection', [format, settings]);
}

/** Same, for "Copy as quote with link". */
export async function convertQuoteInAnyFrame(tabId: number, settings: Settings): Promise<ClipResult | null> {
  return inAnyFrame(tabId, 'convertQuote', [settings]);
}

async function inAnyFrame<K extends 'convertSelection' | 'convertQuote'>(
  tabId: number,
  name: K,
  args: Parameters<PageApi[K]>,
): Promise<Result<K> | null> {
  try {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: [PAGE_SCRIPT] });
    const results = await chrome.scripting.executeScript({
      target,
      func: (name: string, args: unknown[]) => {
        const api = (globalThis as unknown as { __universalCopy?: Record<string, (...values: unknown[]) => unknown> }).__universalCopy;
        const fn = api?.[name];
        return typeof fn === 'function' ? { result: fn(...args), focused: document.hasFocus() } : null;
      },
      args: [name, args as unknown[]],
    });
    const found = results
      .map((injection) => injection.result as { result: Result<K>; focused: boolean } | null | undefined)
      .filter((value): value is { result: Result<K>; focused: boolean } => Boolean(value && value.result.kind !== 'empty'));
    const best = found.find((value) => value.focused) ?? found[0];
    if (best) return best.result;
  } catch {
    // Some frames can't be scripted; try the top frame alone.
  }
  try {
    return await callPage(tabId, 0, name, ...args);
  } catch {
    return null;
  }
}

/**
 * Title and address of the top frame. Read from the page when it can be scripted,
 * otherwise from what Chrome reports for the tab (empty when it reports nothing).
 */
export async function readPageInfo(tab: chrome.tabs.Tab, fallbackUrl?: string): Promise<PageInfo> {
  if (tab.id !== undefined) {
    try {
      return await callPage(tab.id, 0, 'pageInfo');
    } catch {
      // Unscriptable page: use the tab's own fields.
    }
  }
  return { title: tab.title ?? '', url: tab.url ?? fallbackUrl ?? '' };
}
