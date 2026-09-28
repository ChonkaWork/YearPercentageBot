import type { AllowedChannel } from '../core/channels';
import type { FocusState } from '../core/focus';
import type { Route } from '../core/routes';

/** Popup → content script: what page is this, and whose video? */
export interface PageRequest {
  type: 'ytf/page';
}

export interface PageResponse {
  type: 'ytf/page-info';
  route: Route;
  /** The watch page's channel once it's rendered; null elsewhere. */
  channel: AllowedChannel | null;
  state: FocusState;
  hidden: number;
  channelAllowed: boolean;
}

export function isPageRequest(message: unknown): message is PageRequest {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ytf/page';
}

export function isPageResponse(message: unknown): message is PageResponse {
  if (typeof message !== 'object' || message === null) return false;
  const value = message as Partial<PageResponse>;
  return value.type === 'ytf/page-info' && typeof value.route === 'string' && typeof value.state === 'string';
}
