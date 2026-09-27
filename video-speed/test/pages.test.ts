import { describe, expect, it } from 'vitest';
import { unavailableReason } from '../src/core/pages';

describe('unavailableReason', () => {
  it('explains each kind of page', () => {
    expect(unavailableReason('chrome://settings')).toMatch(/its own pages/);
    expect(unavailableReason('chrome-extension://abc/page.html')).toMatch(/other extensions' pages/);
    expect(unavailableReason('https://chromewebstore.google.com/detail/x')).toMatch(/Chrome Web Store/);
    expect(unavailableReason('https://chrome.google.com/webstore/detail/x')).toMatch(/Chrome Web Store/);
    expect(unavailableReason('https://example.com/video')).toMatch(/Reload the page/);
    expect(unavailableReason('file:///home/me/clip.mp4')).toMatch(/Allow access to file URLs/);
  });

  it('gives a generic answer when Chrome does not share the URL', () => {
    expect(unavailableReason(undefined)).toMatch(/chrome:\/\/.*Chrome Web Store.*reload the page/);
    expect(unavailableReason('not a url')).toMatch(/reload the page/);
  });
});
