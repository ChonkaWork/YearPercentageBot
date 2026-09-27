import { describe, expect, it } from 'vitest';
import type { Conversation } from '../src/core/types';
import {
  exportFilename,
  formatConversation,
  formatDateTime,
  JSON_SCHEMA_VERSION,
  shiftHeadings,
  toJsonDocument,
  toMarkdownDocument,
  toTextDocument,
} from '../src/export/formats';

const conversation: Conversation = {
  site: 'chatgpt',
  conversationId: 'abc-123-def',
  title: 'Sorting *fast* in Python',
  url: 'https://chatgpt.com/c/abc-123-def',
  streaming: false,
  messages: [
    { role: 'user', markdown: 'How do I sort?', text: 'How do I sort?' },
    { role: 'assistant', markdown: '# Answer\n\nUse `sorted()`.\n\n```md\n# not a heading\n```', text: 'Answer\n\nUse sorted().\n\n# not a heading' },
  ],
};

// Built from local components so the expected strings don't depend on the machine's time zone.
const exportedAt = new Date(2026, 8, 27, 14, 3, 9);

describe('Markdown export', () => {
  it('has a header, role headings and shifted message headings', () => {
    expect(toMarkdownDocument(conversation, exportedAt)).toBe(
      [
        '# Sorting \\*fast\\* in Python',
        '',
        '- Source: ChatGPT',
        '- URL: <https://chatgpt.com/c/abc-123-def>',
        '- Exported: 2026-09-27 14:03',
        '- Messages: 2',
        '',
        '---',
        '',
        '## You',
        '',
        'How do I sort?',
        '',
        '## ChatGPT',
        '',
        '### Answer',
        '',
        'Use `sorted()`.',
        '',
        '```md',
        '# not a heading',
        '```',
        '',
      ].join('\n'),
    );
  });

  it('names Claude and flags an unfinished reply', () => {
    const out = toMarkdownDocument(
      { ...conversation, site: 'claude', streaming: true, messages: [conversation.messages[0]!, { role: 'assistant', markdown: 'Partial', text: 'Partial', incomplete: true }] },
      exportedAt,
    );
    expect(out).toContain('## Claude\n\nPartial\n\n*(Incomplete: still being generated.)*');
    expect(out).toContain('> **Note:** The last reply was still being generated when this was exported.');
  });
});

describe('shiftHeadings', () => {
  it('shifts headings but not code, math or escaped hashes', () => {
    const input = '# A\n\n###### Deep\n\n~~~\n# code\n~~~\n\n$$\n# tex\n$$\n\n\\# text\n\n   - item\n\n     ## In list';
    expect(shiftHeadings(input, 2)).toBe('### A\n\n###### Deep\n\n~~~\n# code\n~~~\n\n$$\n# tex\n$$\n\n\\# text\n\n   - item\n\n     #### In list');
  });

  it('keeps a longer fence open across shorter ones', () => {
    expect(shiftHeadings('````\n```\n# x\n```\n````\n# y', 1)).toBe('````\n```\n# x\n```\n````\n## y');
  });
});

describe('JSON export', () => {
  it('follows the versioned schema', () => {
    const parsed = JSON.parse(toJsonDocument({ ...conversation, messages: [...conversation.messages, { role: 'assistant', markdown: 'x', text: 'x', incomplete: true }] }, exportedAt));
    expect(parsed).toEqual({
      schemaVersion: JSON_SCHEMA_VERSION,
      source: 'chatgpt',
      title: 'Sorting *fast* in Python',
      url: 'https://chatgpt.com/c/abc-123-def',
      conversationId: 'abc-123-def',
      exportedAt: exportedAt.toISOString(),
      messages: [
        { role: 'user', markdown: 'How do I sort?', text: 'How do I sort?' },
        { role: 'assistant', markdown: conversation.messages[1]!.markdown, text: conversation.messages[1]!.text },
        { role: 'assistant', markdown: 'x', text: 'x', incomplete: true },
      ],
    });
  });
});

describe('plain text export', () => {
  it('uses role labels and separators', () => {
    const out = toTextDocument(conversation, exportedAt);
    expect(out.startsWith('Sorting *fast* in Python\nChatGPT · https://chatgpt.com/c/abc-123-def\nExported 2026-09-27 14:03 · 2 messages\n\n' + '-'.repeat(60))).toBe(true);
    expect(out).toContain('You:\n\nHow do I sort?');
    expect(out).toContain('ChatGPT:\n\nAnswer\n\nUse sorted().');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('dispatches by format name', () => {
    expect(formatConversation('text', conversation, exportedAt)).toBe(toTextDocument(conversation, exportedAt));
  });
});

describe('exportFilename', () => {
  const date = new Date(2026, 0, 5);

  it('adds the date and extension', () => {
    expect(exportFilename('Sorting in Python', date, 'md')).toBe('Sorting in Python 2026-01-05.md');
  });

  it('removes characters that are invalid in file names', () => {
    expect(exportFilename('a/b\\c:d*e?f"g<h>i|j\u0007k', date, 'txt')).toBe('a b c d e f g h i j k 2026-01-05.txt');
  });

  it('keeps Unicode and trims dots and spaces', () => {
    expect(exportFilename('  ...Привіт, café 🎉...  ', date, 'json')).toBe('Привіт, café 🎉 2026-01-05.json');
  });

  it('limits the length without splitting characters', () => {
    const name = exportFilename('😀'.repeat(200), date, 'md');
    expect(Array.from(name.replace(' 2026-01-05.md', '')).length).toBe(80);
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('falls back for empty and reserved names', () => {
    expect(exportFilename('???', date, 'md')).toBe('conversation 2026-01-05.md');
    expect(exportFilename('CON', date, 'md')).toBe('_CON 2026-01-05.md');
  });

  it('formats date and time', () => {
    expect(formatDateTime(new Date(2026, 11, 31, 9, 5))).toBe('2026-12-31 09:05');
  });
});
