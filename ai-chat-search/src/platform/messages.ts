import type { ReadErrorCode } from '../core/read';
import { isSiteId, type Conversation, type Message, type SiteId } from '../core/types';
import type { SaveStatus } from '../storage/record';

// --- Popup → content script ------------------------------------------------------------------

export interface DescribeRequest {
  type: 'ai-chat-search/describe';
}

export interface ReadRequest {
  type: 'ai-chat-search/read';
}

export type ContentRequest = DescribeRequest | ReadRequest;

export type Failure = { ok: false; code: ReadErrorCode | 'INTERNAL'; message: string };

export type DescribeResponse =
  | { ok: true; site: SiteId; conversationId: string | null; title: string; messageCount: number; streaming: boolean }
  | (Failure & { site: SiteId });

export type ReadResponse = { ok: true; conversation: Conversation } | Failure;

export function isContentRequest(value: unknown): value is ContentRequest {
  const type = (value as { type?: unknown } | null)?.type;
  return type === 'ai-chat-search/describe' || type === 'ai-chat-search/read';
}

// --- Content script / popup → service worker -------------------------------------------------

export interface SaveRequest {
  type: 'ai-chat-search/save';
  conversation: Conversation;
  /** 'auto' respects the auto-save setting and private windows; 'manual' is an explicit request. */
  trigger: 'auto' | 'manual';
}

export type SaveResponse =
  | { ok: true; status: SaveStatus; key: string; savedAt: number }
  | { ok: false; code: 'AUTO_OFF' | 'INCOGNITO' | 'NO_ID' | 'LIMIT' | 'STORAGE'; message: string };

/** The content script reports whether it can read the open conversation (shown on the toolbar icon). */
export interface PageStateMessage {
  type: 'ai-chat-search/page-state';
  state: 'ok' | 'problem';
  message?: string;
}

export function isSaveRequest(value: unknown): value is SaveRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.type === 'ai-chat-search/save' && (message.trigger === 'auto' || message.trigger === 'manual') && isConversation(message.conversation);
}

export function isPageStateMessage(value: unknown): value is PageStateMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.type === 'ai-chat-search/page-state' && (message.state === 'ok' || message.state === 'problem');
}

/** Structural check for conversations crossing a context boundary. */
export function isConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null) return false;
  const conversation = value as Record<string, unknown>;
  return (
    isSiteId(conversation.site) &&
    (conversation.conversationId === null || typeof conversation.conversationId === 'string') &&
    typeof conversation.title === 'string' &&
    typeof conversation.url === 'string' &&
    typeof conversation.streaming === 'boolean' &&
    Array.isArray(conversation.messages) &&
    conversation.messages.every(isMessage)
  );
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (message.role === 'user' || message.role === 'assistant') && typeof message.markdown === 'string' && typeof message.text === 'string';
}
