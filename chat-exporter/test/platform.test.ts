import { describe, expect, it } from 'vitest';
import { parseCssColor, relativeLuminance } from '../src/content/theme';
import { isConversation, isPrintRequest } from '../src/platform/messages';
import { sanitizeSettings } from '../src/storage/settings';

const conversation = {
  site: 'claude',
  conversationId: null,
  title: 't',
  url: 'https://claude.ai/new',
  streaming: true,
  messages: [{ role: 'assistant', markdown: 'x', text: 'x', incomplete: true }],
};

describe('page theme detection', () => {
  it('parses computed colors', () => {
    expect(parseCssColor('rgb(33, 33, 33)')).toEqual({ red: 33, green: 33, blue: 33, alpha: 1 });
    expect(parseCssColor('rgba(255, 255, 255, 0)')).toEqual({ red: 255, green: 255, blue: 255, alpha: 0 });
    expect(parseCssColor('rgb(10 20 30 / 50%)')).toEqual({ red: 10, green: 20, blue: 30, alpha: 0.5 });
    expect(parseCssColor('transparent')).toBeNull();
  });

  it('tells dark from light backgrounds', () => {
    expect(relativeLuminance({ red: 33, green: 33, blue: 33, alpha: 1 })).toBeLessThan(0.4);
    expect(relativeLuminance({ red: 255, green: 255, blue: 255, alpha: 1 })).toBeCloseTo(1);
    expect(relativeLuminance({ red: 247, green: 247, blue: 248, alpha: 1 })).toBeGreaterThan(0.4);
  });
});

describe('settings', () => {
  it('shows the button by default and ignores junk', () => {
    expect(sanitizeSettings(undefined)).toEqual({ showButton: true });
    expect(sanitizeSettings({ showButton: 0 })).toEqual({ showButton: true });
    expect(sanitizeSettings({ showButton: false })).toEqual({ showButton: false });
  });
});

describe('message validation', () => {
  it('accepts well-formed print requests only', () => {
    expect(isConversation(conversation)).toBe(true);
    expect(isPrintRequest({ type: 'chat-exporter/print', conversation })).toBe(true);
    expect(isPrintRequest({ type: 'chat-exporter/print', conversation: { ...conversation, messages: 'x' } })).toBe(false);
    expect(isPrintRequest({ type: 'chat-exporter/print', conversation: { ...conversation, site: 'bard' } })).toBe(false);
    expect(isPrintRequest({ type: 'other', conversation })).toBe(false);
    expect(isPrintRequest(null)).toBe(false);
  });
});
