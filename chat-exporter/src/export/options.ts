import type { Conversation } from '../core/types';

/**
 * Export options (Pro). Pure: sanitizing, applying them to a conversation, and describing them.
 * Code blocks are left out while reading the page (see readConversation's `omitCode`), because
 * the plain-text rendition has no reliable code boundaries afterwards.
 */

export interface ExportOptions {
  /** Keep code blocks (false: each becomes "(Code block omitted.)"). */
  includeCode: boolean;
  /** Keep your own messages (false: replies only). */
  includeUser: boolean;
  /** Only the last N exported messages; 0 = all. */
  lastMessages: number;
  /** File name without extension: {title}, {date}, {site}. */
  filenameTemplate: string;
  /** Obsidian / Notion Markdown: tags in the front matter (the site is always added). */
  tags: string[];
  /** Obsidian / Notion Markdown: each message as a callout instead of a heading. */
  callouts: boolean;
}

export const DEFAULT_FILENAME_TEMPLATE = '{title} {date}';
export const FILENAME_TOKENS = ['{title}', '{date}', '{site}'] as const;
export const MAX_LAST_MESSAGES = 999;
export const MAX_TEMPLATE_LENGTH = 120;
export const MAX_TAGS = 10;

export const DEFAULT_EXPORT_OPTIONS: Readonly<ExportOptions> = Object.freeze({
  includeCode: true,
  includeUser: true,
  lastMessages: 0,
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  tags: ['ai-chat'],
  callouts: false,
});

export function sanitizeExportOptions(raw: unknown): ExportOptions {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const bool = (key: keyof ExportOptions) => (typeof input[key] === 'boolean' ? (input[key] as boolean) : (DEFAULT_EXPORT_OPTIONS[key] as boolean));
  const last = typeof input.lastMessages === 'number' && Number.isFinite(input.lastMessages) ? Math.floor(input.lastMessages) : 0;
  const template = typeof input.filenameTemplate === 'string' ? sanitizeTemplate(input.filenameTemplate) : DEFAULT_FILENAME_TEMPLATE;
  return {
    includeCode: bool('includeCode'),
    includeUser: bool('includeUser'),
    lastMessages: Math.min(MAX_LAST_MESSAGES, Math.max(0, last)),
    filenameTemplate: template || DEFAULT_FILENAME_TEMPLATE,
    tags: Array.isArray(input.tags) ? parseTags(input.tags.filter((tag): tag is string => typeof tag === 'string').join(' ')) : [...DEFAULT_EXPORT_OPTIONS.tags],
    callouts: bool('callouts'),
  };
}

function sanitizeTemplate(template: string): string {
  return Array.from(template.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, MAX_TEMPLATE_LENGTH).join('');
}

/**
 * "research, AI/chat  #python" → ["research", "AI/chat", "python"]. Obsidian tags can't contain
 * spaces or most punctuation; letters, digits, `_`, `-` and `/` (nesting) are kept.
 */
export function parseTags(input: string): string[] {
  const tags: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const tag = raw
      .normalize('NFC')
      .replace(/^#+/, '')
      .replace(/[^\p{L}\p{N}_\-/]/gu, '')
      .replace(/^\/+|\/+$/g, '');
    // A tag needs at least one non-digit character.
    if (!tag || /^[\d/]+$/.test(tag) || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

/** The options that apply: stored ones with Pro, the defaults otherwise (stored ones are kept). */
export function effectiveExportOptions(stored: ExportOptions, exportOptionsAllowed: boolean): ExportOptions {
  return exportOptionsAllowed ? stored : { ...DEFAULT_EXPORT_OPTIONS, tags: [...DEFAULT_EXPORT_OPTIONS.tags] };
}

/** Drops user messages when asked, then keeps the last N of what's left. */
export function applyExportOptions(conversation: Conversation, options: ExportOptions): Conversation {
  let messages = options.includeUser ? conversation.messages : conversation.messages.filter((message) => message.role !== 'user');
  if (options.lastMessages > 0 && messages.length > options.lastMessages) messages = messages.slice(-options.lastMessages);
  return messages === conversation.messages ? conversation : { ...conversation, messages };
}

/** Short labels for the options that change the content, e.g. ["Last 10 messages", "No code"]. */
export function describeExportOptions(options: ExportOptions): string[] {
  const labels: string[] = [];
  if (options.lastMessages > 0) labels.push(`Last ${options.lastMessages} ${options.lastMessages === 1 ? 'message' : 'messages'}`);
  if (!options.includeUser) labels.push('Replies only');
  if (!options.includeCode) labels.push('No code blocks');
  return labels;
}
