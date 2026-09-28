import type { SiteAdapter } from '../sites/types';
import { htmlToMarkdown, htmlToText } from './htmlToMarkdown';
import type { Conversation, Message } from './types';

export type ReadErrorCode = 'NOT_CONVERSATION' | 'SITE_CHANGED';

export const READ_ERROR_MESSAGES: Readonly<Record<ReadErrorCode, string>> = {
  NOT_CONVERSATION: 'Open a conversation first.',
  SITE_CHANGED: "Couldn't read this conversation, the site may have changed.",
};

export class ReadError extends Error {
  constructor(readonly code: ReadErrorCode) {
    super(READ_ERROR_MESSAGES[code]);
    this.name = 'ReadError';
  }
}

/**
 * Reads the open conversation through a site adapter.
 *
 * Fails loudly instead of returning something half-right: when the page has a conversation
 * but the expected structure isn't there (no messages, no user turn, or no reply that isn't
 * still being written), it throws SITE_CHANGED so the UI can say so.
 */
export interface ReadOptions {
  /** Replace code blocks with a short note (Pro export option). */
  omitCode?: boolean;
}

export function readConversation(adapter: SiteAdapter, doc: Document, pageUrl: string, readOptions: ReadOptions = {}): Conversation {
  const url = new URL(pageUrl);
  const conversationId = adapter.getConversationId(url);
  const raw = adapter.getMessages(doc);
  if (raw.length === 0) throw new ReadError(conversationId ? 'SITE_CHANGED' : 'NOT_CONVERSATION');

  const options = { skip: adapter.chromeSelector, baseUrl: url.href, omitCode: readOptions.omitCode ?? false };
  const messages: Message[] = [];
  for (const message of raw) {
    const markdown = htmlToMarkdown(message.parts, options);
    const text = htmlToText(message.parts, options);
    if (!text.trim() && !message.streaming) continue;
    const previous = messages[messages.length - 1];
    if (previous && previous.role === message.role) {
      // One turn rendered as several blocks (e.g. text around a tool call): keep it one message.
      previous.markdown = joinParts(previous.markdown, markdown);
      previous.text = joinParts(previous.text, text);
      if (message.streaming) previous.incomplete = true;
      continue;
    }
    messages.push({ role: message.role, markdown, text, ...(message.streaming ? { incomplete: true as const } : {}) });
  }

  const streaming = adapter.isStreaming(doc) || raw.some((message) => message.streaming);
  const hasUser = messages.some((message) => message.role === 'user');
  const hasReply = messages.some((message) => message.role === 'assistant' && (message.text.trim() || message.incomplete));
  if (!hasUser || (!hasReply && !streaming)) throw new ReadError('SITE_CHANGED');
  if (streaming) {
    // The reply being written is the last one, even when the site doesn't mark the message itself.
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') last.incomplete = true;
  }

  const firstUser = messages.find((message) => message.role === 'user');
  const title = adapter.getConversationTitle(doc, url) || titleFromText(firstUser?.text ?? '') || 'Untitled conversation';
  return {
    site: adapter.id,
    conversationId,
    title,
    url: `${url.origin}${url.pathname}`,
    messages,
    streaming,
  };
}

function joinParts(a: string, b: string): string {
  if (!a.trim()) return b;
  if (!b.trim()) return a;
  return `${a}\n\n${b}`;
}

function titleFromText(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim())?.trim() ?? '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}
