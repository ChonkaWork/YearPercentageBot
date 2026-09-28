/** What the history import produces, independent of what is done with it afterwards. */

export type ImportSource = 'chatgpt' | 'claude';

export const IMPORT_SOURCE_NAMES: Readonly<Record<ImportSource, string>> = { chatgpt: 'ChatGPT', claude: 'Claude' };

export interface ImportedMessage {
  role: 'user' | 'assistant';
  /**
   * 'markdown': a reply, which the sites render as Markdown (code blocks, lists…).
   * 'text': what the user typed, which the sites show as typed (Markdown characters are literal).
   */
  format: 'markdown' | 'text';
  content: string;
  createdAt: Date | null;
}

export interface ImportedConversation {
  source: ImportSource;
  /** The conversation's id in the export ('' when it has none). */
  id: string;
  /** Never empty: the export's title, else the first line of the first message, else "Untitled conversation". */
  title: string;
  /** Link to the conversation on the site ('' when the id isn't usable). */
  url: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** User and assistant turns of the visible thread, oldest first. Never empty. */
  messages: ImportedMessage[];
}

/** Messages (or parts of messages) left out, by reason. */
export interface SkippedMessages {
  /** System and tool messages: internal steps the chat doesn't show. */
  system: number;
  /** Messages the site hides from the conversation. */
  hidden: number;
  /** Messages with nothing to show. */
  empty: number;
  /** Content that isn't text, by its type in the export (e.g. "thoughts": 3). */
  unsupported: Record<string, number>;
}

export function emptySkips(): SkippedMessages {
  return { system: 0, hidden: 0, empty: 0, unsupported: {} };
}

export function addSkips(into: SkippedMessages, from: SkippedMessages): void {
  into.system += from.system;
  into.hidden += from.hidden;
  into.empty += from.empty;
  for (const [type, count] of Object.entries(from.unsupported)) into.unsupported[type] = (into.unsupported[type] ?? 0) + count;
}

export interface ParsedConversation {
  /** Null when nothing of the conversation could be kept. */
  conversation: ImportedConversation | null;
  skipped: SkippedMessages;
}

export const UNTITLED = 'Untitled conversation';

/** First non-empty line of the text, at most 80 characters. */
export function titleFromText(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim())?.trim() ?? '';
  const flat = line.replace(/\s+/g, ' ');
  const characters = Array.from(flat);
  return characters.length > 80 ? `${characters.slice(0, 79).join('').trimEnd()}…` : flat;
}

/** Adds a message, merging it into the previous one when the role repeats (one turn around a tool call). */
export function pushMessage(messages: ImportedMessage[], message: ImportedMessage): void {
  const previous = messages[messages.length - 1];
  if (previous && previous.role === message.role && previous.format === message.format) {
    previous.content = `${previous.content}\n\n${message.content}`;
    return;
  }
  messages.push(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
