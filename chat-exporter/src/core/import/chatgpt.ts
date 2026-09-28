import { emptySkips, isRecord, pushMessage, stringOf, titleFromText, UNTITLED, type ImportedMessage, type ParsedConversation } from './types';

/**
 * One conversation of ChatGPT's data export (Settings → Data controls → Export data), from
 * `conversations.json`:
 *
 *   { id | conversation_id, title, create_time, update_time, current_node,
 *     mapping: { [nodeId]: { id, parent, children, message: {
 *       author: { role }, create_time, content: { content_type, parts | text, language? },
 *       metadata: { is_visually_hidden_from_conversation? } } } } }
 *
 * Times are Unix seconds. The mapping is a tree: every edit or regenerated reply starts a branch.
 * The thread the user last saw is the path from `current_node` up through `parent` to the root.
 *
 * UNVERIFIED against a current export: the shape comes from exports as publicly documented and
 * seen in 2024–2025. Unknown content types are skipped and counted, never guessed at.
 */

export function isChatGptConversation(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRecord(value.mapping);
}

export function parseChatGptConversation(raw: Record<string, unknown>): ParsedConversation {
  const skipped = emptySkips();
  const mapping = isRecord(raw.mapping) ? raw.mapping : {};
  const messages: ImportedMessage[] = [];
  const times: number[] = [];

  for (const node of visibleThread(mapping, stringOf(raw.current_node))) {
    const message = node.message;
    if (!isRecord(message)) continue; // The root node usually has no message.
    const author = isRecord(message.author) ? message.author : {};
    const role = author.role;
    if (role !== 'user' && role !== 'assistant') {
      skipped.system++;
      continue;
    }
    const metadata = isRecord(message.metadata) ? message.metadata : {};
    if (metadata.is_visually_hidden_from_conversation === true) {
      skipped.hidden++;
      continue;
    }
    const content = isRecord(message.content) ? message.content : {};
    const type = stringOf(content.content_type) || 'unknown';
    const converted = convertContent(type, content);
    if (converted === null) {
      skipped.unsupported[type] = (skipped.unsupported[type] ?? 0) + 1;
      continue;
    }
    const text = cleanCitations(converted.text);
    if (!text.trim()) {
      skipped.empty++;
      continue;
    }
    const createdAt = fromSeconds(message.create_time);
    if (createdAt) times.push(createdAt.getTime());
    // What the user typed is shown as typed; replies (and code) are Markdown.
    const format = role === 'user' && !converted.markdown ? 'text' : 'markdown';
    pushMessage(messages, { role, format, content: text.replace(/^\n+|\s+$/g, ''), createdAt });
  }

  if (messages.length === 0) return { conversation: null, skipped };
  const id = stringOf(raw.id) || stringOf(raw.conversation_id);
  const firstUser = messages.find((message) => message.role === 'user');
  const createdAt = fromSeconds(raw.create_time) ?? (times.length ? new Date(Math.min(...times)) : null);
  const updatedAt = fromSeconds(raw.update_time) ?? (times.length ? new Date(Math.max(...times)) : createdAt);
  return {
    conversation: {
      source: 'chatgpt',
      id,
      title: stringOf(raw.title).replace(/\s+/g, ' ').trim() || titleFromText(firstUser?.content ?? '') || UNTITLED,
      url: /^[A-Za-z0-9-]{8,}$/.test(id) ? `https://chatgpt.com/c/${id}` : '',
      createdAt,
      updatedAt,
      messages,
    },
    skipped,
  };
}

interface Node {
  id: string;
  parent: string;
  children: string[];
  message: unknown;
}

function nodeOf(mapping: Record<string, unknown>, id: string): Node | null {
  const node = Object.hasOwn(mapping, id) ? mapping[id] : undefined;
  if (!isRecord(node)) return null;
  return {
    id,
    parent: stringOf(node.parent),
    children: Array.isArray(node.children) ? node.children.filter((child): child is string => typeof child === 'string') : [],
    message: node.message,
  };
}

/**
 * The thread shown in ChatGPT: from `current_node` up to the root, oldest first. Without a usable
 * `current_node`, the most recent leaf is used (the last branch written to).
 */
export function visibleThread(mapping: Record<string, unknown>, currentNode: string): Node[] {
  let start = nodeOf(mapping, currentNode);
  if (!start) {
    let best: { node: Node; time: number; order: number } | null = null;
    Object.keys(mapping).forEach((id, order) => {
      const node = nodeOf(mapping, id);
      if (!node || node.children.some((child) => nodeOf(mapping, child))) return;
      const message = isRecord(node.message) ? node.message : {};
      const time = fromSeconds(message.create_time)?.getTime() ?? -Infinity;
      if (!best || time > best.time || (time === best.time && order > best.order)) best = { node, time, order };
    });
    start = (best as { node: Node } | null)?.node ?? null;
  }
  const path: Node[] = [];
  const seen = new Set<string>();
  for (let node = start; node && !seen.has(node.id); node = node.parent ? nodeOf(mapping, node.parent) : null) {
    seen.add(node.id);
    path.push(node);
  }
  return path.reverse();
}

/** Text of a message's content, or null for content types that aren't converted. */
function convertContent(type: string, content: Record<string, unknown>): { text: string; markdown: boolean } | null {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  switch (type) {
    case 'text':
      return { text: parts.filter((part): part is string => typeof part === 'string').join('\n\n'), markdown: false };
    case 'multimodal_text':
      return { text: parts.map(multimodalPart).filter(Boolean).join('\n\n'), markdown: false };
    case 'code': {
      const code = stringOf(content.text).replace(/\s+$/, '');
      if (!code.trim()) return { text: '', markdown: true };
      const language = stringOf(content.language).replace(/[^\w#+.-]/g, '');
      return { text: fence(code, language === 'unknown' ? '' : language), markdown: true };
    }
    default:
      return null;
  }
}

function multimodalPart(part: unknown): string {
  if (typeof part === 'string') return part;
  // Voice messages carry their transcript.
  if (isRecord(part) && part.content_type === 'audio_transcription' && typeof part.text === 'string') return part.text;
  return '[image]';
}

/** A fenced code block whose fence is longer than any backtick run inside the code. */
export function fence(code: string, language = ''): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const marker = '`'.repeat(longest + 1);
  return `${marker}${language}\n${code}\n${marker}`;
}

/**
 * Newer replies with web results carry citation markers in private-use characters
 * (U+E200 … U+E201, e.g. "citeturn0search3"), which show up as garbage outside ChatGPT.
 * UNVERIFIED: based on exports seen in 2025.
 */
function cleanCitations(text: string): string {
  return text.replace(/[^]{0,200}/g, '');
}

function fromSeconds(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}
