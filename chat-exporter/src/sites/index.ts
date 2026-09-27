import { chatgpt } from './chatgpt';
import { claude } from './claude';
import type { SiteAdapter } from './types';

export const ADAPTERS: readonly SiteAdapter[] = [chatgpt, claude];

export function adapterFor(url: URL): SiteAdapter | null {
  const adapter = ADAPTERS.find((candidate) => candidate.detect(url));
  if (adapter) return adapter;
  if (__E2E__ && url.hostname === '127.0.0.1') {
    // Test build only: fixture pages are served as /chatgpt/… and /claude/… from a local server.
    const site = url.pathname.split('/')[1];
    return ADAPTERS.find((candidate) => candidate.id === site) ?? null;
  }
  return null;
}
