import type { PageApi } from '../page/index';
import type { RecorderApi } from '../recorder/index';

/**
 * Talks to the scripts injected into a tab on demand (activeTab + scripting): page.js
 * (reading tables, toasts, outlines) and recorder.js (row recording). A script is injected
 * with one executeScript, then its functions are called with a second one. Both throw when
 * Chrome doesn't let extensions script the page (chrome://, the Web Store, the PDF
 * viewer...).
 *
 * Each context injects a script once per tab and frame, then only calls it; when the
 * call finds the script missing (the page navigated), it injects again and retries.
 */

type Api = Record<string, (...args: never[]) => unknown>;
type Result<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

const SCRIPTS = {
  page: { file: 'page.js', global: '__tableCopy' },
  recorder: { file: 'recorder.js', global: '__tableCopyRecorder' },
} as const;

type ScriptName = keyof typeof SCRIPTS;

const NOT_LOADED = 'Table Copy: script not loaded';
const injected = new Set<string>();

/** Runs in the page, serialized: must stay self-contained. */
function invoke(global: string, name: string, args: unknown[]): unknown {
  const api = (globalThis as unknown as Record<string, Record<string, (...values: unknown[]) => unknown> | undefined>)[global];
  const fn = api?.[name];
  if (typeof fn !== 'function') return { __tableCopyMissing: true };
  return fn(...args);
}

async function call<A extends Api, K extends keyof A & string>(script: ScriptName, tabId: number, frameId: number, name: K, args: Parameters<A[K]>): Promise<Result<A[K]>> {
  const { file, global } = SCRIPTS[script];
  const target = { tabId, frameIds: [frameId] };
  const key = `${script}:${tabId}:${frameId}`;
  const run = async (): Promise<Result<A[K]>> => {
    const [injection] = await chrome.scripting.executeScript({ target, func: invoke, args: [global, name, args] });
    if (!injection) throw new Error('No result from the page');
    const failed = (injection as { error?: unknown }).error;
    if (failed) throw new Error(String(failed));
    const result = injection.result as { __tableCopyMissing?: boolean } | undefined;
    if (result && typeof result === 'object' && result.__tableCopyMissing) throw new Error(NOT_LOADED);
    return injection.result as Result<A[K]>;
  };
  if (injected.has(key)) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== NOT_LOADED) throw error;
    }
  }
  await chrome.scripting.executeScript({ target, files: [file] });
  injected.add(key);
  return run();
}

export function callPage<K extends keyof PageApi & string>(tabId: number, frameId: number, name: K, ...args: Parameters<PageApi[K]>): Promise<Result<PageApi[K]>> {
  return call<PageApi, K>('page', tabId, frameId, name, args);
}

export function callRecorder<K extends keyof RecorderApi & string>(
  tabId: number,
  frameId: number,
  name: K,
  ...args: Parameters<RecorderApi[K]>
): Promise<Result<RecorderApi[K]>> {
  return call<RecorderApi, K>('recorder', tabId, frameId, name, args);
}

/** Calls the recorder only if it's already in the page (never injects it). */
export async function peekRecorder<K extends keyof RecorderApi & string>(
  tabId: number,
  name: K,
  ...args: Parameters<RecorderApi[K]>
): Promise<Result<RecorderApi[K]> | null> {
  const { global } = SCRIPTS.recorder;
  const [injection] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: invoke, args: [global, name, args] });
  const result = injection?.result as { __tableCopyMissing?: boolean } | undefined;
  if (!injection || (injection as { error?: unknown }).error || (result && typeof result === 'object' && result.__tableCopyMissing)) return null;
  return injection.result as Result<RecorderApi[K]>;
}
