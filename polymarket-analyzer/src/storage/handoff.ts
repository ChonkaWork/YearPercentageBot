import { normalizeQuery } from '../core/search';

/**
 * Hand-off from the context menu (background) to the popup, through session storage.
 * Kept separate from store.ts so the service worker bundle stays small.
 */

const PENDING_KEY = 'pending';
const PENDING_MAX_AGE_MS = 5 * 60 * 1000;

export type Pending = { kind: 'analyze'; url: string; createdAt: number } | { kind: 'search'; query: string; createdAt: number };

export async function setPending(pending: { kind: 'analyze'; url: string } | { kind: 'search'; query: string }): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: { ...pending, createdAt: Date.now() } });
}

/** Reads and clears the hand-off. Entries older than 5 minutes are ignored. */
export async function takePending(): Promise<Pending | null> {
  try {
    const value = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] as Record<string, unknown> | undefined;
    await chrome.storage.session.remove(PENDING_KEY);
    if (!value || typeof value.createdAt !== 'number' || Date.now() - value.createdAt > PENDING_MAX_AGE_MS || value.createdAt > Date.now() + 1000) return null;
    if (value.kind === 'analyze' && typeof value.url === 'string' && value.url.length < 2048) {
      return { kind: 'analyze', url: value.url, createdAt: value.createdAt };
    }
    if (value.kind === 'search' && typeof value.query === 'string' && normalizeQuery(value.query)) {
      return { kind: 'search', query: normalizeQuery(value.query), createdAt: value.createdAt };
    }
    return null;
  } catch {
    return null;
  }
}
