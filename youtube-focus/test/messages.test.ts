import { describe, expect, it } from 'vitest';
import { isPageRequest, isPageResponse } from '../src/platform/messages';

describe('messages', () => {
  it('recognizes the popup request', () => {
    expect(isPageRequest({ type: 'ytf/page' })).toBe(true);
    for (const bad of [null, undefined, 'ytf/page', { type: 'other' }]) expect(isPageRequest(bad)).toBe(false);
  });

  it('validates the page response', () => {
    expect(isPageResponse({ type: 'ytf/page-info', route: 'watch', state: 'on', channel: null, hidden: 3, channelAllowed: false })).toBe(true);
    expect(isPageResponse({ type: 'ytf/page-info', route: 1, state: 'on' })).toBe(false);
    expect(isPageResponse(undefined)).toBe(false);
  });
});
