import { chatgpt } from './chatgpt';
import { claude } from './claude';
import type { SiteAdapter } from './types';

export const ADAPTERS: readonly SiteAdapter[] = [chatgpt, claude];

export function adapterFor(url: URL): SiteAdapter | null {
  return ADAPTERS.find((candidate) => candidate.detect(url)) ?? null;
}
