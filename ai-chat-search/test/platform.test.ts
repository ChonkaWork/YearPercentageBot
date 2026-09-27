import { describe, expect, it } from 'vitest';
import { autoSaveRefusal } from '../src/background/policy';
import { isConversation, isPageStateMessage, isSaveRequest } from '../src/platform/messages';
import { sanitizeSettings } from '../src/storage/settings';
import { formatDay, plural, relativeTime } from '../src/ui/format';

const conversation = {
  site: 'chatgpt',
  conversationId: 'abc',
  title: 't',
  url: 'https://chatgpt.com/c/abc',
  streaming: false,
  messages: [{ role: 'user', markdown: 'x', text: 'x' }],
};

describe('auto-save policy', () => {
  it('saves automatically only when auto-save is on and the window is not private', () => {
    expect(autoSaveRefusal('auto', true, false)).toBeNull();
    expect(autoSaveRefusal('auto', false, false)?.code).toBe('AUTO_OFF');
    expect(autoSaveRefusal('auto', true, true)?.code).toBe('INCOGNITO');
  });

  it('always allows an explicit save', () => {
    expect(autoSaveRefusal('manual', false, true)).toBeNull();
  });
});

describe('settings', () => {
  it('defaults to auto-save on and ignores junk', () => {
    expect(sanitizeSettings(undefined)).toEqual({ autoSave: true });
    expect(sanitizeSettings({ autoSave: 'no' })).toEqual({ autoSave: true });
    expect(sanitizeSettings({ autoSave: false, extra: 1 })).toEqual({ autoSave: false });
  });
});

describe('message validation', () => {
  it('accepts well-formed save requests only', () => {
    expect(isSaveRequest({ type: 'ai-chat-search/save', trigger: 'auto', conversation })).toBe(true);
    expect(isSaveRequest({ type: 'ai-chat-search/save', trigger: 'later', conversation })).toBe(false);
    expect(isSaveRequest({ type: 'ai-chat-search/save', trigger: 'manual', conversation: { ...conversation, site: 'gemini' } })).toBe(false);
    expect(isConversation({ ...conversation, messages: [{ role: 'tool', markdown: '', text: '' }] })).toBe(false);
    expect(isPageStateMessage({ type: 'ai-chat-search/page-state', state: 'problem', message: 'x' })).toBe(true);
    expect(isPageStateMessage({ type: 'ai-chat-search/page-state', state: 'maybe' })).toBe(false);
  });
});

describe('formatting', () => {
  const now = new Date(2026, 8, 27, 12).getTime();
  it('formats relative times and days', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe('yesterday');
    expect(formatDay(new Date(2026, 1, 3).getTime(), now)).toBe('Feb 3');
    expect(formatDay(new Date(2024, 1, 3).getTime(), now)).toBe('Feb 3, 2024');
    expect(plural(1, 'result')).toBe('1 result');
    expect(plural(1200, 'result')).toBe('1,200 results');
  });
});
