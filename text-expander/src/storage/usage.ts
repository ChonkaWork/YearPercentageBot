/**
 * Usage stats in chrome.storage.local. The service worker is the only writer: the content
 * script and the popup report a use with a message, so two tabs expanding at the same moment
 * can't overwrite each other's count. Small on purpose: the content script bundles it.
 */

import { sanitizeSnippets } from '../core/snippets';
import { recordUse, sanitizeUsage, type UsageEntry } from '../core/usage';
import { SNIPPETS_KEY, USAGE_KEY } from './keys';

export const USAGE_MESSAGE = 'snippets/used';

export interface UsageMessage {
  type: typeof USAGE_MESSAGE;
  id: string;
}

export function isUsageMessage(message: unknown): message is UsageMessage {
  const candidate = message as Partial<UsageMessage> | null;
  return candidate?.type === USAGE_MESSAGE && typeof candidate.id === 'string' && candidate.id.length > 0 && candidate.id.length <= 64;
}

/** Tells the service worker a snippet was used. Never throws: stats must not break an expansion. */
export function reportUsage(id: string): void {
  try {
    const message: UsageMessage = { type: USAGE_MESSAGE, id };
    chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // The extension was reloaded while this page stayed open.
  }
}

export async function loadUsage(): Promise<Record<string, UsageEntry>> {
  const data = await chrome.storage.local.get(USAGE_KEY);
  return sanitizeUsage(data[USAGE_KEY]);
}

let queue: Promise<unknown> = Promise.resolve();

/** Service worker only: counts one use. Entries of deleted snippets are dropped on the way. */
export function recordUsage(id: string, now = Date.now()): Promise<void> {
  const run = queue.then(async () => {
    const data = await chrome.storage.local.get([USAGE_KEY, SNIPPETS_KEY]);
    const ids = new Set(sanitizeSnippets(data[SNIPPETS_KEY]).map((snippet) => snippet.id));
    if (!ids.has(id)) return;
    await chrome.storage.local.set({ [USAGE_KEY]: recordUse(sanitizeUsage(data[USAGE_KEY]), id, now, ids) });
  });
  queue = run.catch(() => undefined);
  return run;
}
