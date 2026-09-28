import type { ReadErrorCode } from '../core/read';
import { isSiteId, type Conversation, type Message, type SiteId } from '../core/types';

// --- Popup → content script ------------------------------------------------------------------

export interface DescribeRequest {
  type: 'chat-exporter/describe';
}

export interface ReadRequest {
  type: 'chat-exporter/read';
}

export type ContentRequest = DescribeRequest | ReadRequest;

export type Failure = { ok: false; code: ReadErrorCode | 'INTERNAL'; message: string };

export type DescribeResponse =
  | {
      ok: true;
      site: SiteId;
      title: string;
      /** Messages that will be exported (after the export options). */
      messageCount: number;
      /** Messages on the page. */
      totalCount: number;
      streaming: boolean;
    }
  | (Failure & { site: SiteId });

export type ReadResponse = { ok: true; conversation: Conversation } | Failure;

export function isContentRequest(value: unknown): value is ContentRequest {
  const type = (value as { type?: unknown } | null)?.type;
  return type === 'chat-exporter/describe' || type === 'chat-exporter/read';
}

// --- Content script / popup → background -----------------------------------------------------

export interface PrintRequest {
  type: 'chat-exporter/print';
  conversation: Conversation;
  /** Suggested PDF file name (without extension), from the file name template. */
  title?: string;
}

export type PrintResponse = { ok: true } | { ok: false; message: string };

export function isPrintRequest(value: unknown): value is PrintRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.type === 'chat-exporter/print' && isConversation(message.conversation) && (message.title === undefined || typeof message.title === 'string');
}

/** Opens the options page at the "About Pro" card (content scripts can't open extension pages). */
export interface OpenOptionsRequest {
  type: 'chat-exporter/open-options';
  section?: 'pro' | 'options';
}

export function isOpenOptionsRequest(value: unknown): value is OpenOptionsRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.type === 'chat-exporter/open-options' && (message.section === undefined || message.section === 'pro' || message.section === 'options');
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

// --- Print view hand-off (chrome.storage.session) ---------------------------------------------

export const PRINT_KEY_PREFIX = 'print:';

export interface PrintPayload {
  conversation: Conversation;
  exportedAt: number;
  title?: string;
}
