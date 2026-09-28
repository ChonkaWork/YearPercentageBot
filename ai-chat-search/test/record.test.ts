import { describe, expect, it } from 'vitest';
import type { Conversation } from '../src/core/types';
import { NORMALIZER_VERSION } from '../src/search/normalize';
import { buildIndexExport, buildRecord, formatBytes, sanitizeRecord, signatureOf, withMeta } from '../src/storage/record';

const conversation: Conversation = {
  site: 'claude',
  conversationId: 'abc-123',
  title: 'Rust ownership',
  url: 'https://claude.ai/chat/abc-123',
  streaming: false,
  messages: [
    { role: 'user', markdown: '**Explain**', text: 'Explain' },
    { role: 'assistant', markdown: 'Owner é', text: 'Owner é' },
  ],
};

describe('buildRecord', () => {
  it('creates a record with search text and size', () => {
    const { record, status } = buildRecord(conversation, undefined, 1000);
    expect(status).toBe('created');
    expect(record).toMatchObject({
      key: 'claude:abc-123',
      site: 'claude',
      conversationId: 'abc-123',
      title: 'Rust ownership',
      messages: [
        { role: 'user', text: 'Explain' },
        { role: 'assistant', text: 'Owner é' },
      ],
      createdAt: 1000,
      updatedAt: 1000,
      savedAt: 1000,
      searchText: ' explain \n owner e ',
      normalizerVersion: NORMALIZER_VERSION,
      starred: false,
      tags: [],
    });
    expect(record.bytes).toBe('Rust ownership'.length + 'Explain'.length + 'Owner é'.length + 1);
  });

  it('keeps createdAt/updatedAt when nothing changed', () => {
    const first = buildRecord(conversation, undefined, 1000).record;
    const again = buildRecord(conversation, first, 5000);
    expect(again.status).toBe('unchanged');
    expect(again.record).toMatchObject({ createdAt: 1000, updatedAt: 1000, savedAt: 5000 });
  });

  it('bumps updatedAt when the content changed', () => {
    const first = buildRecord(conversation, undefined, 1000).record;
    const changed = buildRecord({ ...conversation, messages: [...conversation.messages, { role: 'user', markdown: 'More', text: 'More' }] }, first, 5000);
    expect(changed.status).toBe('updated');
    expect(changed.record).toMatchObject({ createdAt: 1000, updatedAt: 5000 });
    expect(changed.record.searchText).toContain(' more ');
  });

  it('keeps the star and tags when the conversation is saved again', () => {
    const first = withMeta(buildRecord(conversation, undefined, 1000).record, { starred: true, tags: ['Rust', 'work'] });
    const unchanged = buildRecord(conversation, first, 2000);
    expect(unchanged.record).toMatchObject({ starred: true, tags: ['Rust', 'work'] });
    const changed = buildRecord({ ...conversation, title: 'Rust ownership 2' }, first, 3000);
    expect(changed.status).toBe('updated');
    expect(changed.record).toMatchObject({ starred: true, tags: ['Rust', 'work'] });
  });

  it('withMeta cleans tags and leaves the rest alone', () => {
    const record = buildRecord(conversation, undefined, 1000).record;
    expect(withMeta(record, { tags: [' #Rust ', 'rust', ''] }).tags).toEqual(['Rust']);
    expect(withMeta(record, { starred: true })).toEqual({ ...record, starred: true });
  });

  it('refuses conversations without an id', () => {
    expect(() => buildRecord({ ...conversation, conversationId: null }, undefined, 1)).toThrow();
  });

  it('signatures differ for different content and roles', () => {
    const a = signatureOf('t', [{ role: 'user', text: 'x' }]);
    expect(signatureOf('t', [{ role: 'assistant', text: 'x' }])).not.toBe(a);
    expect(signatureOf('t', [{ role: 'user', text: 'y' }])).not.toBe(a);
    expect(signatureOf('t', [{ role: 'user', text: 'x' }])).toBe(a);
  });
});

describe('sanitizeRecord', () => {
  it('rejects malformed records', () => {
    expect(sanitizeRecord(null)).toBeNull();
    expect(sanitizeRecord({ key: 'x' })).toBeNull();
    expect(sanitizeRecord({ ...buildRecord(conversation, undefined, 1).record, site: 'gemini' })).toBeNull();
  });

  it('rebuilds search text from an older normalizer and drops bad messages', () => {
    const { record } = buildRecord(conversation, undefined, 1);
    const old = { ...record, searchText: 'stale', normalizerVersion: 0, messages: [...record.messages, { role: 'tool', text: 'x' }, 'junk'] };
    const fixed = sanitizeRecord(old);
    expect(fixed?.searchText).toBe(' explain \n owner e ');
    expect(fixed?.messages).toHaveLength(2);
  });

  it('defaults star and tags on records saved before they existed, and cleans them', () => {
    const { record } = buildRecord(conversation, undefined, 1);
    const { starred: _starred, tags: _tags, ...old } = record;
    expect(sanitizeRecord(old)).toMatchObject({ starred: false, tags: [] });
    expect(sanitizeRecord({ ...record, starred: 'yes', tags: ['a', 'A', 7, ' b '] })).toMatchObject({ starred: false, tags: ['a', 'b'] });
  });
});

describe('index export', () => {
  it('writes a versioned JSON document, newest first', () => {
    const older = buildRecord({ ...conversation, conversationId: 'old', title: 'Older' }, undefined, Date.UTC(2026, 0, 1)).record;
    const newer = withMeta(buildRecord(conversation, undefined, Date.UTC(2026, 5, 1)).record, { starred: true, tags: ['rust'] });
    const data = JSON.parse(buildIndexExport([older, newer], new Date(Date.UTC(2026, 8, 27))));
    expect(data.schemaVersion).toBe(1);
    expect(data.kind).toBe('ai-chat-search-index');
    expect(data.exportedAt).toBe('2026-09-27T00:00:00.000Z');
    expect(data.conversations.map((item: { title: string }) => item.title)).toEqual(['Rust ownership', 'Older']);
    expect(data.conversations[1]).toMatchObject({ starred: false, tags: [] });
    expect(data.conversations[0]).toEqual({
      source: 'claude',
      conversationId: 'abc-123',
      title: 'Rust ownership',
      url: 'https://claude.ai/chat/abc-123',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      starred: true,
      tags: ['rust'],
      messages: [
        { role: 'user', text: 'Explain' },
        { role: 'assistant', text: 'Owner é' },
      ],
    });
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024)).toBe('50 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});
