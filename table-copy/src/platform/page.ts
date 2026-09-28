import type { PageApi } from '../page/index';

/**
 * Talks to page.js inside a tab. The script is injected on demand (activeTab + scripting),
 * then its functions are called with a second executeScript. Both calls throw when Chrome
 * doesn't let extensions script the page (chrome://, the Web Store, the PDF viewer...).
 */

const PAGE_SCRIPT = 'page.js';

type Result<K extends keyof PageApi> = ReturnType<PageApi[K]>;

/** Runs in the page, serialized: must stay self-contained. */
function invoke(name: string, args: unknown[]): unknown {
  const api = (globalThis as unknown as { __tableCopy?: Record<string, (...values: unknown[]) => unknown> }).__tableCopy;
  const fn = api?.[name];
  if (typeof fn !== 'function') throw new Error('Table Copy: page script not loaded');
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
