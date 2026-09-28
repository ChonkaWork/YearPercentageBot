import { emptySkips, isRecord, pushMessage, stringOf, titleFromText, UNTITLED, type ImportedMessage, type ParsedConversation } from './types';

/**
 * One conversation of Claude's data export (Settings → Privacy → Export data), from
 * `conversations.json`:
 *
 *   { uuid, name, created_at, updated_at,
 *     chat_messages: [ { uuid, sender: 'human' | 'assistant', text,
 *       content?: [ { type: 'text', text } | { type: 'tool_use' | 'thinking' | … } ],
 *       created_at, attachments?: [ { file_name } ], files?: [ { file_name } ] } ] }
 *
 * Times are ISO 8601 strings. `content` blocks are preferred when there are text blocks (newer
 * exports); otherwise `text` is used. Other block types are counted as unsupported.
 *
 * UNVERIFIED against a current export: the shape comes from exports seen in 2024–2025.
 */

export function isClaudeConversation(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.chat_messages);
}

export function parseClaudeConversation(raw: Record<string, unknown>): ParsedConversation {
  const skipped = emptySkips();
  const messages: ImportedMessage[] = [];
  const list = Array.isArray(raw.chat_messages) ? raw.chat_messages : [];

  for (const message of list) {
    if (!isRecord(message)) continue;
    const role = message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : null;
    if (!role) {
      skipped.system++;
      continue;
    }
    let text = stringOf(message.text);
    if (Array.isArray(message.content) && message.content.length > 0) {
      const texts: string[] = [];
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        const type = stringOf(block.type) || 'unknown';
        if (type === 'text') texts.push(stringOf(block.text));
        else skipped.unsupported[type] = (skipped.unsupported[type] ?? 0) + 1;
      }
      if (texts.some((part) => part.trim())) text = texts.filter((part) => part.trim()).join('\n\n');
    }
    const files = [...fileNames(message.attachments), ...fileNames(message.files)];
    const body = [...new Set(files)].map((name) => `[File: ${name}]`);
    if (text.trim()) body.push(text.replace(/^\n+|\s+$/g, ''));
    if (body.length === 0) {
      skipped.empty++;
      continue;
    }
    // What the user typed is shown as typed; replies are Markdown.
    pushMessage(messages, { role, format: role === 'user' ? 'text' : 'markdown', content: body.join('\n\n'), createdAt: fromIso(message.created_at) });
  }

  if (messages.length === 0) return { conversation: null, skipped };
  const id = stringOf(raw.uuid);
  const firstUser = messages.find((message) => message.role === 'user');
  const times = messages.map((message) => message.createdAt?.getTime()).filter((time): time is number => time !== undefined);
  const createdAt = fromIso(raw.created_at) ?? (times.length ? new Date(Math.min(...times)) : null);
  const updatedAt = fromIso(raw.updated_at) ?? (times.length ? new Date(Math.max(...times)) : createdAt);
  return {
    conversation: {
      source: 'claude',
      id,
      title: stringOf(raw.name).replace(/\s+/g, ' ').trim() || titleFromText(stripFileLines(firstUser?.content ?? '')) || UNTITLED,
      url: /^[A-Za-z0-9-]{8,}$/.test(id) ? `https://claude.ai/chat/${id}` : '',
      createdAt,
      updatedAt,
      messages,
    },
    skipped,
  };
}

function fileNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((file) => (isRecord(file) ? stringOf(file.file_name).replace(/\s+/g, ' ').trim() : ''))
    .filter((name) => name !== '');
}

function stripFileLines(text: string): string {
  return text.replace(/^(\[File: [^\]\n]*\]\n*)+/, '');
}

function fromIso(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}
