import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import chatgptExport from '../e2e/fixtures/chatgpt-export.json?raw';
import claudeExport from '../e2e/fixtures/claude-export.json?raw';
import { fence, parseChatGptConversation, visibleThread } from '../src/core/import/chatgpt';
import { parseClaudeConversation } from '../src/core/import/claude';
import {
  findConversationsJson,
  IMPORT_ERROR_MESSAGES,
  importHistory,
  ImportError,
  parseConversation,
  ZipWriter,
  type ImportedConversation,
  type ImportProgress,
} from '../src/core/import';

const chatgpt = JSON.parse(chatgptExport) as Record<string, unknown>[];
const claude = JSON.parse(claudeExport) as Record<string, unknown>[];

function conversationOf(result: ReturnType<typeof parseChatGptConversation>): ImportedConversation {
  if (!result.conversation) throw new Error('expected a conversation');
  return result.conversation;
}

async function zipOf(files: Record<string, string>): Promise<Blob> {
  const writer = new ZipWriter();
  for (const [name, content] of Object.entries(files)) void writer.add(name, content);
  return new Blob((await writer.finish()) as BlobPart[], { type: 'application/zip' });
}

async function run(file: Blob, extra: Partial<Parameters<typeof importHistory>[1]> = {}) {
  const conversations: ImportedConversation[] = [];
  const summary = await importHistory(file, { onConversation: (conversation) => void conversations.push(conversation), ...extra });
  return { summary, conversations };
}

async function importError(file: Blob, extra: Partial<Parameters<typeof importHistory>[1]> = {}): Promise<ImportError> {
  try {
    await run(file, extra);
  } catch (error) {
    if (error instanceof ImportError) return error;
    throw error;
  }
  throw new Error('expected an ImportError');
}

// --- ChatGPT ------------------------------------------------------------------------------------

describe('ChatGPT export', () => {
  it('keeps the visible thread: the regenerated reply, not the old branch', () => {
    const result = parseChatGptConversation(chatgpt[0] as Record<string, unknown>);
    const conversation = conversationOf(result);
    expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conversation.messages.some((message) => message.content.includes('OLD BRANCH'))).toBe(false);
    expect(conversation.messages[1]?.content).toMatch(/^Use `sorted\(\)` with a \*\*key function\*\*/);
  });

  it('skips the hidden system message and unsupported content, and counts them', () => {
    expect(parseChatGptConversation(chatgpt[0] as Record<string, unknown>).skipped).toEqual({ system: 1, hidden: 0, empty: 0, unsupported: { thoughts: 1 } });
  });

  it('counts hidden user or assistant messages separately from system ones', () => {
    const raw = {
      id: 'hidden-0001',
      current_node: 'b',
      mapping: {
        a: { id: 'a', parent: null, children: ['b'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Custom instructions'] }, metadata: { is_visually_hidden_from_conversation: true } } },
        b: { id: 'b', parent: 'a', children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Hi'] } } },
      },
    };
    const result = parseChatGptConversation(raw);
    expect(result.skipped.hidden).toBe(1);
    expect(conversationOf(result).messages).toEqual([{ role: 'user', format: 'text', content: 'Hi', createdAt: null }]);
  });

  it('turns images into [image] and keeps the text of multimodal messages as typed', () => {
    const user = conversationOf(parseChatGptConversation(chatgpt[0] as Record<string, unknown>)).messages[2];
    expect(user).toMatchObject({ role: 'user', format: 'text', content: '[image]\n\nHere is my benchmark. Does <script>alert("x")</script> sort before letters?' });
  });

  it('uses the export dates (Unix seconds) for the conversation and its messages', () => {
    const conversation = conversationOf(parseChatGptConversation(chatgpt[0] as Record<string, unknown>));
    expect(conversation.createdAt?.toISOString()).toBe('2026-09-27T10:02:03.123Z');
    expect(conversation.updatedAt?.toISOString()).toBe('2026-09-27T10:09:41.123Z');
    expect(conversation.messages[0]?.createdAt?.toISOString()).toBe('2026-09-27T10:02:03.123Z');
    expect(conversation).toMatchObject({ source: 'chatgpt', id: '6710aa01-1111-4000-8000-000000000001', title: 'Sorting in Python', url: 'https://chatgpt.com/c/6710aa01-1111-4000-8000-000000000001' });
  });

  it('fences code, drops tool output and keeps a reply split around a tool call as one turn', () => {
    const result = parseChatGptConversation(chatgpt[1] as Record<string, unknown>);
    const conversation = conversationOf(result);
    expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(conversation.messages[1]?.content).toBe(
      '```python\nbudget = 5000\nprint(budget - 2 * 1200 - 900)\n```\n\n## Субота\n\n- Площа Ринок і Ратуша\n- Кава у «Львівській копальні кави»\n\n## Неділя\n\nВисокий Замок. **Залишок:** близько 1 700 грн.',
    );
    expect(result.skipped).toMatchObject({ system: 1 });
  });

  it('titles an untitled conversation from its first message, and follows the latest leaf without current_node', () => {
    const conversation = conversationOf(parseChatGptConversation(chatgpt[2] as Record<string, unknown>));
    expect(conversation.title).toBe('Regex for ISO dates like 2026-09-27?');
    expect(conversation.messages[1]?.content).toMatch(/^```regex\n/);
  });

  it('returns no conversation when nothing is visible', () => {
    const result = parseChatGptConversation(chatgpt[4] as Record<string, unknown>);
    expect(result.conversation).toBeNull();
    expect(result.skipped.system).toBe(1);
  });

  it('falls back to "Untitled conversation", conversation_id, and no URL for odd ids', () => {
    const raw = {
      conversation_id: 'x',
      mapping: { a: { id: 'a', parent: null, children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['  '] } } } },
      current_node: 'a',
    };
    expect(parseChatGptConversation(raw).skipped.empty).toBe(1);
    const withText = { ...raw, mapping: { a: { id: 'a', parent: null, children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Hello'] } } } } };
    expect(conversationOf(parseChatGptConversation(withText))).toMatchObject({ id: 'x', title: 'Untitled conversation', url: '', createdAt: null, updatedAt: null });
  });

  it('survives a cycle in the parent links', () => {
    const mapping = {
      a: { id: 'a', parent: 'b', children: ['b'], message: null },
      b: { id: 'b', parent: 'a', children: ['a'], message: null },
    };
    expect(visibleThread(mapping, 'a').map((node) => node.id)).toEqual(['b', 'a']);
  });

  it('removes citation markers and cleans code language names', () => {
    const raw = {
      id: 'cite-000001',
      current_node: 'a',
      mapping: {
        a: { id: 'a', parent: null, children: ['b'], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Kyiv is the capital.citeturn0search3'] } } },
        b: { id: 'b', parent: 'a', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'code', language: 'unknown', text: 'x = 1' } } },
      },
    };
    const reply = conversationOf(parseChatGptConversation({ ...raw, current_node: 'b' })).messages[0];
    expect(reply?.content).toBe('Kyiv is the capital.\n\n```\nx = 1\n```');
  });

  it('makes a fence longer than any backtick run in the code', () => {
    expect(fence('a ``` b', 'md')).toBe('````md\na ``` b\n````');
    expect(fence('plain')).toBe('```\nplain\n```');
  });
});

// --- Claude -------------------------------------------------------------------------------------

describe('Claude export', () => {
  it('prefers content text blocks over the text field and counts other blocks', () => {
    const result = parseClaudeConversation(claude[0] as Record<string, unknown>);
    const conversation = conversationOf(result);
    expect(conversation.messages.map((message) => [message.role, message.format])).toEqual([
      ['user', 'text'],
      ['assistant', 'markdown'],
      ['user', 'text'],
      ['assistant', 'markdown'],
    ]);
    expect(conversation.messages[1]?.content).toMatch(/^Every value has \*\*one owner\*\*/);
    expect(conversation.messages[1]?.content).toContain('```rust\nfn main() {');
    expect(conversation.messages.some((message) => message.content.includes('older than the content blocks'))).toBe(false);
    expect(result.skipped.unsupported).toEqual({ thinking: 1 });
  });

  it('lists attachments and files, and uses text when there are no content blocks', () => {
    const conversation = conversationOf(parseClaudeConversation(claude[0] as Record<string, unknown>));
    expect(conversation.messages[2]?.content).toBe('[File: main.rs]\n\n[File: error.png]\n\nWhy does this fail to compile?');
    expect(conversation.messages[3]?.content).toBe('`s` was moved into `t`, so it can no longer be used. Clone it (`s.clone()`) or borrow it (`&s`).');
  });

  it('reads ISO dates, the uuid and builds the claude.ai link', () => {
    const conversation = conversationOf(parseClaudeConversation(claude[0] as Record<string, unknown>));
    expect(conversation).toMatchObject({ source: 'claude', id: '0f3c2a9e-5b1d-4c8e-9a77-2d4e6f8a1b2c', title: 'Rust ownership basics', url: 'https://claude.ai/chat/0f3c2a9e-5b1d-4c8e-9a77-2d4e6f8a1b2c' });
    expect(conversation.createdAt?.toISOString()).toBe('2026-09-20T07:15:00.000Z');
    expect(conversation.updatedAt?.toISOString()).toBe('2026-09-20T07:31:12.000Z');
  });

  it('titles an unnamed conversation from its first message; an empty chat gives nothing', () => {
    expect(conversationOf(parseClaudeConversation(claude[1] as Record<string, unknown>)).title).toBe('Draft a polite reminder about the unpaid invoice #1042');
    expect(parseClaudeConversation(claude[2] as Record<string, unknown>).conversation).toBeNull();
  });

  it('skips other senders and merges repeated roles', () => {
    const result = parseClaudeConversation({
      uuid: 'u',
      name: 'x',
      chat_messages: [
        { sender: 'human', text: 'one' },
        { sender: 'human', text: 'two' },
        { sender: 'system', text: 'internal' },
        { sender: 'assistant', text: '' },
      ],
    });
    expect(result.skipped).toMatchObject({ system: 1, empty: 1 });
    expect(conversationOf(result).messages).toEqual([{ role: 'user', format: 'text', content: 'one\n\ntwo', createdAt: null }]);
  });
});

describe('format detection', () => {
  it('recognises each export by its shape', () => {
    expect(parseConversation(chatgpt[0])?.conversation?.source).toBe('chatgpt');
    expect(parseConversation(claude[0])?.conversation?.source).toBe('claude');
    expect(parseConversation({ title: 'x', messages: [] })).toBeNull();
    expect(parseConversation('text')).toBeNull();
  });

  it('finds conversations.json at any depth, ignoring macOS resource forks', () => {
    const entry = (name: string, size = 10) => ({ name, method: 8, flags: 0, crc32: 0, compressedSize: 5, size, localHeaderOffset: 0 });
    expect(findConversationsJson([entry('__MACOSX/Export/._conversations.json'), entry('Export/deep/conversations.json'), entry('Export/conversations.json')])?.name).toBe('Export/conversations.json');
    expect(findConversationsJson([entry('Conversations.JSON')])?.name).toBe('Conversations.JSON');
    expect(findConversationsJson([entry('chat.html'), entry('conversations.json', 0)])).toBeNull();
  });
});

// --- The whole import ---------------------------------------------------------------------------

describe('importHistory', () => {
  it('reads conversations.json from a ChatGPT zip and reports what it skipped', async () => {
    const zip = await zipOf({
      'chat.html': '<html></html>',
      '__MACOSX/Export/._conversations.json': 'resource fork',
      'Export/conversations.json': chatgptExport,
      'Export/file-Abc123.png': 'png',
    });
    const progress: ImportProgress[] = [];
    const { summary, conversations } = await run(zip, { onProgress: (update) => progress.push(update) });
    expect(conversations.map((conversation) => conversation.title)).toEqual(['Sorting in Python', 'Trip to Lviv', 'Regex for ISO dates like 2026-09-27?', 'Sorting in Python']);
    expect(summary).toEqual({
      sources: ['chatgpt'],
      conversations: 4,
      messages: 10,
      skippedMessages: { system: 3, hidden: 0, empty: 0, unsupported: { thoughts: 1 } },
      skippedConversations: { unrecognized: 0, empty: 1 },
      path: 'Export/conversations.json',
    });
    const last = progress[progress.length - 1];
    expect(last).toMatchObject({ conversations: 4 });
    expect(last?.bytesRead).toBe(last?.totalBytes);
  });

  it('reads a bare conversations.json from Claude', async () => {
    const { summary, conversations } = await run(new Blob([claudeExport], { type: 'application/json' }));
    expect(summary).toMatchObject({ sources: ['claude'], conversations: 2, messages: 6, skippedConversations: { unrecognized: 0, empty: 1 }, path: 'conversations.json' });
    expect(conversations[0]?.title).toBe('Rust ownership basics');
  });

  it('counts elements it does not recognise, as long as some conversations are found', async () => {
    const mixed = JSON.stringify([{ something: 'else' }, JSON.parse(claudeExport)[0]]);
    const { summary } = await run(new Blob([mixed]));
    expect(summary.skippedConversations.unrecognized).toBe(1);
    expect(summary.conversations).toBe(1);
  });

  it('explains what is wrong with the file', async () => {
    const noJson = await importError(await zipOf({ 'chat.html': '<html></html>', 'user.json': '{}' }));
    expect(noJson.code).toBe('NO_CONVERSATIONS_JSON');
    expect(noJson.message).toBe(
      'This zip has no conversations.json. Use the zip from ChatGPT (Settings → Data controls → Export data) or Claude (Settings → Privacy → Export data).',
    );
    expect((await importError(new Blob(['%PDF-1.7 not an export']))).code).toBe('NOT_EXPORT');
    expect((await importError(new Blob(['{"conversations": []}']))).code).toBe('NOT_A_LIST');
    expect((await importError(new Blob(['[]']))).code).toBe('NO_CONVERSATIONS');
    expect((await importError(new Blob(['[{"title": "x"}, {"messages": []}]']))).code).toBe('UNKNOWN_FORMAT');
    expect((await importError(new Blob(['[{"mapping": {}}, {"mapping": nope}]']))).code).toBe('NOT_JSON');
    expect((await importError(new Blob(['[{"mapping": {}}, {"mapping"']))).code).toBe('NOT_JSON');
    expect(IMPORT_ERROR_MESSAGES.UNKNOWN_FORMAT).toMatch(/format may have changed/);
  });

  it('refuses a damaged zip and an oversized conversations.json', async () => {
    const zip = new Uint8Array(await (await zipOf({ 'conversations.json': chatgptExport })).arrayBuffer());
    const damaged = zip.slice();
    damaged[60] = (damaged[60] ?? 0) ^ 0xff;
    expect((await importError(new Blob([damaged as BlobPart]))).code).toBe('BAD_ZIP');
    const tooLarge = await importError(new Blob([zip as BlobPart]), { limits: { maxEntryBytes: 1000 } });
    expect(tooLarge.code).toBe('TOO_LARGE');
    expect(tooLarge.message).toMatch(/^conversations\.json is 12(\.\d)? KB, more than the 1000 bytes that can be read\.$/);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const error = await importError(new Blob([chatgptExport]), {
      signal: controller.signal,
      onConversation: () => controller.abort(),
    });
    expect(error.code).toBe('ABORTED');
  });

  it("passes the caller's own errors through unchanged", async () => {
    const failure = new TypeError('disk full');
    await expect(
      importHistory(new Blob([chatgptExport]), {
        onConversation: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
});

describe('the import engine can be copied as a folder', () => {
  it('imports only from its own folder and uses no Chrome or DOM APIs', () => {
    const folder = new URL('../src/core/import/', import.meta.url);
    const files = readdirSync(folder).filter((name) => name.endsWith('.ts'));
    expect(files.sort()).toEqual(['chatgpt.ts', 'claude.ts', 'index.ts', 'jsonArray.ts', 'types.ts', 'zip.ts']);
    for (const name of files) {
      const source = readFileSync(new URL(name, folder), 'utf8');
      for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) expect(specifier, `${name} imports ${specifier}`).toMatch(/^\.\/[\w]+$/);
      expect(source, name).not.toMatch(/\bchrome\.|\bdocument\.|\bwindow\./);
    }
  });
});
