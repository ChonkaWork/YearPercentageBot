import { escapeMarkdown } from '../core/htmlToMarkdown';
import { SITE_NAMES, type Conversation, type Role, type SiteId } from '../core/types';

export const EXPORT_FORMATS = ['markdown', 'json', 'text'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const FORMAT_INFO: Readonly<Record<ExportFormat, { label: string; extension: string; mime: string }>> = {
  markdown: { label: 'Markdown', extension: 'md', mime: 'text/markdown' },
  json: { label: 'JSON', extension: 'json', mime: 'application/json' },
  text: { label: 'Plain text', extension: 'txt', mime: 'text/plain' },
};

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

export function roleLabel(role: Role, site: SiteId): string {
  return role === 'user' ? 'You' : SITE_NAMES[site];
}

const INCOMPLETE_NOTE = 'The last reply was still being generated when this was exported.';

export function formatConversation(format: ExportFormat, conversation: Conversation, exportedAt: Date): string {
  switch (format) {
    case 'markdown':
      return toMarkdownDocument(conversation, exportedAt);
    case 'json':
      return toJsonDocument(conversation, exportedAt);
    case 'text':
      return toTextDocument(conversation, exportedAt);
  }
}

export function toMarkdownDocument(conversation: Conversation, exportedAt: Date): string {
  const site = SITE_NAMES[conversation.site];
  const parts = [
    `# ${escapeMarkdown(conversation.title).replace(/\s+/g, ' ')}`,
    [
      `- Source: ${site}`,
      `- URL: <${conversation.url}>`,
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
    `${SITE_NAMES[conversation.site]} · ${conversation.url}`,
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

/** "2026-09-27 14:03" in local time. */
export function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "2026-09-27" in local time. */
export function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_NAME_LENGTH = 80;

/** "Sorting in Python 2026-09-27.md": safe on Windows, macOS and Linux. */
export function exportFilename(title: string, date: Date, extension: string): string {
  let base = title
    .normalize('NFC')
    // Characters that are invalid in file names somewhere, and control characters.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const codePoints = Array.from(base);
  if (codePoints.length > MAX_NAME_LENGTH) base = codePoints.slice(0, MAX_NAME_LENGTH).join('').trim();
  base = base.replace(/^[.\s]+|[.\s]+$/g, '');
  if (RESERVED_NAMES.test(base)) base = `_${base}`;
  if (!base) base = 'conversation';
  return `${base} ${formatDate(date)}.${extension}`;
}
