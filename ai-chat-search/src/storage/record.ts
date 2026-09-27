import { isSiteId, type Conversation, type Role, type SiteId } from '../core/types';
import { buildSearchText } from '../search/engine';
import { NORMALIZER_VERSION } from '../search/normalize';

/** One saved conversation, as stored in IndexedDB. */
export interface StoredConversation {
  /** `${site}:${conversationId}` */
  key: string;
  site: SiteId;
  conversationId: string;
  title: string;
  url: string;
  messages: { role: Role; text: string }[];
  /** First saved. */
  createdAt: number;
  /** Last time the content (title or messages) changed. */
  updatedAt: number;
  /** Last time it was saved, changed or not. */
  savedAt: number;
  /** Content hash, to skip writes when nothing changed. */
  signature: string;
  /** UTF-8 size of title and messages. */
  bytes: number;
  /** Precomputed search text (see search/normalize.ts). */
  searchText: string;
  normalizerVersion: number;
}

export type SaveStatus = 'created' | 'updated' | 'unchanged';

export function conversationKey(site: SiteId, conversationId: string): string {
  return `${site}:${conversationId}`;
}

/** Turns a conversation read from the page into the stored record. */
export function buildRecord(
  conversation: Conversation,
  previous: StoredConversation | undefined,
  now: number,
): { record: StoredConversation; status: SaveStatus } {
  if (!conversation.conversationId) throw new Error('Only conversations with an id can be saved.');
  const messages = conversation.messages.map(({ role, text }) => ({ role, text }));
  const signature = signatureOf(conversation.title, messages);
  if (previous && previous.signature === signature && previous.normalizerVersion === NORMALIZER_VERSION) {
    return { record: { ...previous, url: conversation.url, savedAt: now }, status: 'unchanged' };
  }
  const record: StoredConversation = {
    key: conversationKey(conversation.site, conversation.conversationId),
    site: conversation.site,
    conversationId: conversation.conversationId,
    title: conversation.title,
    url: conversation.url,
    messages,
    createdAt: previous?.createdAt ?? now,
    updatedAt: previous && previous.signature === signature ? previous.updatedAt : now,
    savedAt: now,
    signature,
    bytes: utf8Length(conversation.title) + messages.reduce((sum, message) => sum + utf8Length(message.text), 0),
    searchText: buildSearchText(messages),
    normalizerVersion: NORMALIZER_VERSION,
  };
  return { record, status: previous ? 'updated' : 'created' };
}

/** FNV-1a (32 bit) over title and messages, plus the total length: cheap change detection. */
export function signatureOf(title: string, messages: readonly { role: Role; text: string }[]): string {
  let hash = 0x811c9dc5;
  let length = 0;
  const feed = (text: string) => {
    length += text.length;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  feed(title);
  for (const message of messages) {
    feed(`\u0000${message.role}\u0000`);
    feed(message.text);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${length.toString(36)}`;
}

const encoder = new TextEncoder();
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Validates a record read from storage. Returns null for anything malformed; rebuilds the search
 * text when it was made by an older normalizer.
 */
export function sanitizeRecord(raw: unknown): StoredConversation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.key !== 'string' ||
    !isSiteId(value.site) ||
    typeof value.conversationId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string' ||
    !Array.isArray(value.messages) ||
    typeof value.updatedAt !== 'number'
  ) {
    return null;
  }
  const messages = value.messages.filter(
    (message): message is { role: Role; text: string } =>
      typeof message === 'object' && message !== null && (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string',
  );
  const record = raw as StoredConversation;
  const current = record.normalizerVersion === NORMALIZER_VERSION && typeof record.searchText === 'string';
  return {
    ...record,
    messages,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : value.updatedAt,
    savedAt: typeof value.savedAt === 'number' ? value.savedAt : value.updatedAt,
    signature: typeof value.signature === 'string' ? value.signature : signatureOf(value.title, messages),
    bytes: typeof value.bytes === 'number' ? value.bytes : utf8Length(value.title) + messages.reduce((sum, message) => sum + utf8Length(message.text), 0),
    searchText: current ? record.searchText : buildSearchText(messages),
    normalizerVersion: NORMALIZER_VERSION,
  };
}

/** Version of the index export format. Bump on breaking changes only. */
export const INDEX_EXPORT_VERSION = 1;

export function buildIndexExport(records: readonly StoredConversation[], exportedAt: Date): string {
  const data = {
    schemaVersion: INDEX_EXPORT_VERSION,
    kind: 'ai-chat-search-index',
    exportedAt: exportedAt.toISOString(),
    conversations: [...records]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => ({
        source: record.site,
        conversationId: record.conversationId,
        title: record.title,
        url: record.url,
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
        messages: record.messages.map(({ role, text }) => ({ role, text })),
      })),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
