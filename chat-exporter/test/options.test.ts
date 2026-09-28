import { describe, expect, it } from 'vitest';
import type { Conversation } from '../src/core/types';
import { buildExportFile, pdfTitle } from '../src/export/actions';
import {
  applyExportOptions,
  DEFAULT_EXPORT_OPTIONS,
  describeExportOptions,
  effectiveExportOptions,
  parseTags,
  sanitizeExportOptions,
  type ExportOptions,
} from '../src/export/options';

const conversation: Conversation = {
  site: 'claude',
  conversationId: 'x',
  title: 'Rust: ownership',
  url: 'https://claude.ai/chat/x',
  streaming: false,
  messages: [
    { role: 'user', markdown: 'q1', text: 'q1' },
    { role: 'assistant', markdown: 'a1', text: 'a1' },
    { role: 'user', markdown: 'q2', text: 'q2' },
    { role: 'assistant', markdown: 'a2', text: 'a2' },
  ],
};

const options = (patch: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...patch });

describe('sanitizeExportOptions', () => {
  it('defaults everything', () => {
    expect(sanitizeExportOptions(undefined)).toEqual({
      includeCode: true,
      includeUser: true,
      lastMessages: 0,
      filenameTemplate: '{title} {date}',
      tags: ['ai-chat'],
      callouts: false,
    });
    expect(sanitizeExportOptions('junk')).toEqual(sanitizeExportOptions({}));
  });

  it('keeps valid values and repairs junk', () => {
    expect(
      sanitizeExportOptions({ includeCode: false, includeUser: 'no', lastMessages: 5.7, filenameTemplate: ' {site}\n{title} ', tags: ['#Research', 42, 'a b'], callouts: true }),
    ).toEqual({ includeCode: false, includeUser: true, lastMessages: 5, filenameTemplate: '{site} {title}', tags: ['Research', 'a', 'b'], callouts: true });
    expect(sanitizeExportOptions({ lastMessages: -3 }).lastMessages).toBe(0);
    expect(sanitizeExportOptions({ lastMessages: 1e9 }).lastMessages).toBe(999);
    expect(sanitizeExportOptions({ lastMessages: Number.NaN }).lastMessages).toBe(0);
    expect(sanitizeExportOptions({ filenameTemplate: '   ' }).filenameTemplate).toBe('{title} {date}');
    expect(sanitizeExportOptions({ filenameTemplate: 'x'.repeat(500) }).filenameTemplate).toHaveLength(120);
    expect(sanitizeExportOptions({ tags: [] }).tags).toEqual([]);
  });
});

describe('parseTags', () => {
  it('splits on commas and spaces, strips # and punctuation, dedupes', () => {
    expect(parseTags('research, AI/chat  #python;python')).toEqual(['research', 'AI/chat', 'python']);
    expect(parseTags('Привіт! café_notes 2026 /x/')).toEqual(['Привіт', 'café_notes', 'x']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(' '))).toHaveLength(10);
  });
});

describe('applyExportOptions', () => {
  it('returns the same conversation with the defaults', () => {
    expect(applyExportOptions(conversation, options())).toBe(conversation);
  });

  it('keeps the last N messages', () => {
    expect(applyExportOptions(conversation, options({ lastMessages: 2 })).messages.map((m) => m.markdown)).toEqual(['q2', 'a2']);
    expect(applyExportOptions(conversation, options({ lastMessages: 10 })).messages).toHaveLength(4);
  });

  it('drops user messages, then counts the last N', () => {
    expect(applyExportOptions(conversation, options({ includeUser: false })).messages.map((m) => m.markdown)).toEqual(['a1', 'a2']);
    expect(applyExportOptions(conversation, options({ includeUser: false, lastMessages: 1 })).messages.map((m) => m.markdown)).toEqual(['a2']);
  });

  it('does not change the original', () => {
    applyExportOptions(conversation, options({ includeUser: false }));
    expect(conversation.messages).toHaveLength(4);
  });
});

describe('effective options and labels', () => {
  it('uses the stored options only when the plan allows them', () => {
    const stored = options({ lastMessages: 3, includeCode: false });
    expect(effectiveExportOptions(stored, true)).toBe(stored);
    expect(effectiveExportOptions(stored, false)).toEqual(DEFAULT_EXPORT_OPTIONS);
  });

  it('describes what changes the content', () => {
    expect(describeExportOptions(options())).toEqual([]);
    expect(describeExportOptions(options({ lastMessages: 1, includeUser: false, includeCode: false }))).toEqual(['Last 1 message', 'Replies only', 'No code blocks']);
    expect(describeExportOptions(options({ lastMessages: 10 }))).toEqual(['Last 10 messages']);
  });
});

describe('export files', () => {
  const now = new Date(2026, 8, 27, 14, 3);

  it('names files from the template', () => {
    expect(buildExportFile('markdown', conversation, now, options()).filename).toBe('Rust ownership 2026-09-27.md');
    const file = buildExportFile('obsidian', conversation, now, options({ filenameTemplate: '{date} {site} - {title}' }));
    expect(file.filename).toBe('2026-09-27 Claude - Rust ownership.md');
    expect(file.mime).toBe('text/markdown');
    expect(file.content.startsWith('---\ntitle: "Rust: ownership"\n')).toBe(true);
    expect(buildExportFile('json', conversation, now, options()).filename).toBe('Rust ownership 2026-09-27.json');
    expect(pdfTitle(conversation, now, options({ filenameTemplate: '{title}' }))).toBe('Rust ownership');
  });
});
