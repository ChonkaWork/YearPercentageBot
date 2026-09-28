import { escapeMarkdown } from '../core/htmlToMarkdown';
import type { ProFeature } from '../core/plan';
import { SITE_NAMES, type Conversation, type Role, type SiteId } from '../core/types';
import { formatDate, formatDateTime, formatLocalIso, roleLabel } from './labels';
import { DEFAULT_EXPORT_OPTIONS, DEFAULT_FILENAME_TEMPLATE } from './options';

export { formatDate, formatDateTime, roleLabel } from './labels';

/** Formats downloaded as a file (PDF goes through the print view instead). */
export const EXPORT_FORMATS = ['markdown', 'text', 'html', 'obsidian', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Formats built by formatConversation (HTML has its own builder, src/export/html.ts). */
export type TextFormat = Exclude<ExportFormat, 'html'>;

export const FORMAT_INFO: Readonly<Record<ExportFormat, { label: string; extension: string; mime: string; pro?: ProFeature }>> = {
  markdown: { label: 'Markdown', extension: 'md', mime: 'text/markdown' },
  text: { label: 'Plain text', extension: 'txt', mime: 'text/plain' },
  html: { label: 'HTML', extension: 'html', mime: 'text/html' },
  obsidian: { label: 'Obsidian / Notion Markdown', extension: 'md', mime: 'text/markdown', pro: 'obsidian' },
  json: { label: 'JSON', extension: 'json', mime: 'application/json', pro: 'json' },
};

/** Options of the Obsidian / Notion Markdown format. */
export interface ObsidianOptions {
  tags: readonly string[];
  callouts: boolean;
}

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** Version of the JSON export format. Bump on breaking changes only. */
export const JSON_SCHEMA_VERSION = 1;

export interface JsonExport {
  schemaVersion: number;
  source: SiteId;
  title: string;
  url: string;
  conversationId: string | null;
  exportedAt: string;
  messages: { role: Role; markdown: string; text: string; incomplete?: true }[];
}

const INCOMPLETE_NOTE = 'The last reply was still being generated when this was exported.';

/** A conversation's own dates, known for conversations from a history import (not from a page). */
export interface ConversationDates {
  created: Date | null;
  updated: Date | null;
}

export function formatConversation(
  format: TextFormat,
  conversation: Conversation,
  exportedAt: Date,
  obsidian: ObsidianOptions = DEFAULT_EXPORT_OPTIONS,
  dates?: ConversationDates,
): string {
  switch (format) {
    case 'markdown':
      return toMarkdownDocument(conversation, exportedAt, dates);
    case 'json':
      return toJsonDocument(conversation, exportedAt);
    case 'text':
      return toTextDocument(conversation, exportedAt);
    case 'obsidian':
      return toObsidianDocument(conversation, exportedAt, obsidian, dates);
  }
}

export function toMarkdownDocument(conversation: Conversation, exportedAt: Date, dates?: ConversationDates): string {
  const site = SITE_NAMES[conversation.site];
  const parts = [
    `# ${escapeMarkdown(conversation.title).replace(/\s+/g, ' ')}`,
    [
      `- Source: ${site}`,
      ...(conversation.url ? [`- URL: <${conversation.url}>`] : []),
      ...(dates?.created ? [`- Created: ${formatDateTime(dates.created)}`] : []),
      ...(dates?.updated ? [`- Updated: ${formatDateTime(dates.updated)}`] : []),
      `- Exported: ${formatDateTime(exportedAt)}`,
      `- Messages: ${conversation.messages.length}`,
    ].join('\n'),
  ];
  if (conversation.streaming) parts.push(`> **Note:** ${INCOMPLETE_NOTE}`);
  parts.push('---');
  for (const message of conversation.messages) {
    parts.push(`## ${roleLabel(message.role, conversation.site)}`);
    // Message headings go below the "## You" / "## ChatGPT" level so the outline stays intact.
    if (message.markdown.trim()) parts.push(shiftHeadings(message.markdown, 2));
    if (message.incomplete) parts.push('*(Incomplete: still being generated.)*');
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * Markdown for note apps: YAML front matter (title, source, url, date, tags), then the messages
 * as `## You` / `## ChatGPT` sections, or as Obsidian callouts (`> [!question] You`). No H1 and
 * no metadata list: note apps show the file name as the title and the front matter as properties.
 */
export function toObsidianDocument(conversation: Conversation, exportedAt: Date, options: ObsidianOptions, dates?: ConversationDates): string {
  const tags = [...options.tags];
  if (!tags.includes(conversation.site)) tags.push(conversation.site);
  const frontMatter = [
    '---',
    `title: ${yamlString(conversation.title.replace(/\s+/g, ' ').trim())}`,
    `source: ${yamlString(SITE_NAMES[conversation.site])}`,
    ...(conversation.url ? [`url: ${yamlString(conversation.url)}`] : []),
    // A conversation's own date when it is known (history import), else the day it was exported.
    `date: ${formatDate(dates?.created ?? exportedAt)}`,
    ...(dates?.created ? [`created: ${formatLocalIso(dates.created)}`] : []),
    ...(dates?.updated ? [`updated: ${formatLocalIso(dates.updated)}`] : []),
    ...(tags.length ? ['tags:', ...tags.map((tag) => `  - ${yamlString(tag)}`)] : ['tags: []']),
    '---',
  ].join('\n');
  const parts = [frontMatter];
  if (conversation.streaming) parts.push(options.callouts ? `> [!warning] Incomplete\n> ${INCOMPLETE_NOTE}` : `> **Note:** ${INCOMPLETE_NOTE}`);
  for (const message of conversation.messages) {
    const label = roleLabel(message.role, conversation.site);
    const body = message.markdown.trim() ? shiftHeadings(message.markdown, 2) : '';
    const note = message.incomplete ? '*(Incomplete: still being generated.)*' : '';
    if (options.callouts) {
      const content = [body, note].filter(Boolean).join('\n\n');
      const lines = content ? content.split('\n').map((line) => (line ? `> ${line}` : '>')) : [];
      parts.push([`> [!${message.role === 'user' ? 'question' : 'note'}] ${label}`, ...lines].join('\n'));
    } else {
      parts.push(`## ${label}`);
      if (body) parts.push(body);
      if (note) parts.push(note);
    }
  }
  return `${parts.join('\n\n')}\n`;
}

/** A double-quoted YAML scalar: safe for any title (colons, quotes, `#`, leading dashes, Unicode). */
export function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

export function toJsonDocument(conversation: Conversation, exportedAt: Date): string {
  const document: JsonExport = {
    schemaVersion: JSON_SCHEMA_VERSION,
    source: conversation.site,
    title: conversation.title,
    url: conversation.url,
    conversationId: conversation.conversationId,
    exportedAt: exportedAt.toISOString(),
    messages: conversation.messages.map((message) => ({
      role: message.role,
      markdown: message.markdown,
      text: message.text,
      ...(message.incomplete ? { incomplete: true as const } : {}),
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function toTextDocument(conversation: Conversation, exportedAt: Date): string {
  const rule = '-'.repeat(60);
  const header = [
    conversation.title,
    [SITE_NAMES[conversation.site], conversation.url].filter(Boolean).join(' · '),
    `Exported ${formatDateTime(exportedAt)} · ${conversation.messages.length} messages`,
  ];
  if (conversation.streaming) header.push(INCOMPLETE_NOTE);
  const messages = conversation.messages.map((message) => {
    const label = `${roleLabel(message.role, conversation.site)}:`;
    const note = message.incomplete ? '\n\n(Incomplete: still being generated.)' : '';
    return `${label}\n\n${message.text}${note}`;
  });
  return `${[header.join('\n'), ...messages].join(`\n\n${rule}\n\n`)}\n`;
}

/**
 * Moves ATX headings down by `levels` (capped at h6), leaving fenced code and math blocks alone.
 */
export function shiftHeadings(markdown: string, levels: number): string {
  let fence: { char: string; length: number } | null = null;
  let math = false;
  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (fenceMatch?.[1] && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
        return line;
      }
      if (fenceMatch?.[1]) {
        fence = { char: fenceMatch[1][0] ?? '`', length: fenceMatch[1].length };
        return line;
      }
      if (/^\s*\$\$/.test(line)) {
        const single = /^\s*\$\$.+\$\$\s*$/.test(line);
        if (!single) math = !math;
        return line;
      }
      if (math) return line;
      return line.replace(/^(\s*)(#{1,6})(?=\s|$)/, (_, space: string, hashes: string) => `${space}${'#'.repeat(Math.min(6, hashes.length + levels))}`);
    })
    .join('\n');
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_NAME_LENGTH = 80;
const MAX_BASE_LENGTH = 150;

export interface FilenameOptions {
  /** {title}, {date} and {site}; default "{title} {date}". */
  template?: string;
  site?: SiteId;
}

/**
 * "Sorting in Python 2026-09-27.md" by default, or from a template ("{site} - {title}").
 * Safe on Windows, macOS and Linux, whatever the title or template contains.
 */
export function exportFilename(title: string, date: Date, extension: string, options: FilenameOptions = {}): string {
  const template = options.template?.trim() || DEFAULT_FILENAME_TEMPLATE;
  let cleanTitle = cleanName(title, MAX_NAME_LENGTH) || 'conversation';
  if (RESERVED_NAMES.test(cleanTitle)) cleanTitle = `_${cleanTitle}`;
  const values: Record<string, string> = {
    title: cleanTitle,
    date: formatDate(date),
    site: options.site ? SITE_NAMES[options.site] : '',
  };
  let base = cleanName(
    template.replace(/\{(title|date|site)\}/gi, (_, token: string) => values[token.toLowerCase()] ?? ''),
    MAX_BASE_LENGTH,
  );
  if (RESERVED_NAMES.test(base)) base = `_${base}`;
  if (!base) base = `conversation ${values.date}`;
  return `${base}.${extension}`;
}

/** File-name-safe text, at most `max` code points (never splits a character). */
function cleanName(text: string, max: number): string {
  let name = text
    .normalize('NFC')
    // Characters that are invalid in file names somewhere, and control characters.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const codePoints = Array.from(name);
  if (codePoints.length > max) name = codePoints.slice(0, max).join('').trim();
  return name.replace(/^[.\s]+|[.\s]+$/g, '');
}
