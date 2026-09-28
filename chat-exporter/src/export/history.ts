import { escapeMarkdown, plainTextToMarkdown } from '../core/htmlToMarkdown';
import { IMPORT_SOURCE_NAMES, ZipWriter, type ImportedConversation, type ImportSource, type ImportSummary } from '../core/import';
import type { Conversation } from '../core/types';
import { exportFilename, toMarkdownDocument, toObsidianDocument, type ConversationDates } from './formats';
import { formatDate, formatDateTime } from './labels';
import type { ExportOptions } from './options';

/**
 * Your whole history: conversations from the history import (src/core/import) become one Markdown
 * file each, named with the file name template, plus an index.md listing them by date, all in one
 * zip. Pure (no DOM, no Chrome APIs): the options page feeds it and saves the result.
 */

export type HistoryFormat = 'obsidian' | 'markdown';

export interface HistoryOptions {
  format: HistoryFormat;
  /** File name template and the Obsidian tags / callouts (the content options don't apply). */
  exportOptions: ExportOptions;
  /** "Exported" time in the files and the date of the zip. */
  now: Date;
}

export interface HistoryEntry {
  file: string;
  title: string;
  source: ImportSource;
  date: Date | null;
  messages: number;
}

export const INDEX_FILE = 'index.md';
/** Compressions running at once (keeps memory flat on big histories). */
const MAX_IN_FLIGHT = 8;

export class HistoryArchive {
  private readonly zip = new ZipWriter();
  private readonly names = new UniqueNames([INDEX_FILE]);
  readonly entries: HistoryEntry[] = [];

  constructor(private readonly options: HistoryOptions) {}

  /** Adds one conversation; returns its file name. */
  async add(imported: ImportedConversation): Promise<string> {
    const conversation = toConversation(imported);
    const dates: ConversationDates = { created: imported.createdAt, updated: imported.updatedAt };
    const date = imported.createdAt ?? imported.updatedAt;
    const { exportOptions, now } = this.options;
    const file = this.names.claim(exportFilename(conversation.title, date ?? now, 'md', { template: exportOptions.filenameTemplate, site: conversation.site }));
    const content =
      this.options.format === 'obsidian' ? toObsidianDocument(conversation, now, exportOptions, dates) : toMarkdownDocument(conversation, now, dates);
    this.entries.push({ file, title: conversation.title, source: imported.source, date, messages: conversation.messages.length });
    const pending = this.zip.add(file, content, imported.updatedAt ?? date ?? now);
    if (this.zip.inFlight >= MAX_IN_FLIGHT) await pending;
    return file;
  }

  /** Adds index.md and returns the zip's bytes. */
  async finish(summary: Pick<ImportSummary, 'sources' | 'path'>): Promise<Uint8Array[]> {
    void this.zip.add(INDEX_FILE, historyIndex(this.entries, summary, this.options.now), this.options.now);
    return this.zip.finish();
  }
}

/** An imported conversation in the shape the formats expect. */
export function toConversation(imported: ImportedConversation): Conversation {
  return {
    site: imported.source,
    conversationId: imported.id || null,
    title: imported.title,
    url: imported.url,
    streaming: false,
    messages: imported.messages.map((message) => ({
      role: message.role,
      // Typed text is escaped so it reads as typed; replies are Markdown already.
      markdown: message.format === 'text' ? plainTextToMarkdown(message.content) : message.content,
      text: message.content,
    })),
  };
}

/**
 * File names that don't collide: "Name.md", then "Name (2).md", "Name (3).md"… Case-insensitive,
 * like Windows and macOS. Remembers the next free number, so thousands of same-titled
 * conversations stay fast.
 */
export class UniqueNames {
  private readonly taken = new Set<string>();
  private readonly next = new Map<string, number>();

  constructor(reserved: Iterable<string> = []) {
    for (const name of reserved) this.taken.add(name.toLowerCase());
  }

  claim(name: string): string {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    if (this.taken.has(candidate.toLowerCase())) {
      const key = name.toLowerCase();
      let n = this.next.get(key) ?? 2;
      for (candidate = `${base} (${n})${extension}`; this.taken.has(candidate.toLowerCase()); candidate = `${base} (${n})${extension}`) n++;
      this.next.set(key, n + 1);
    }
    this.taken.add(candidate.toLowerCase());
    return candidate;
  }
}

/** index.md: newest first, grouped by month; conversations without a date at the end. */
export function historyIndex(entries: readonly HistoryEntry[], summary: Pick<ImportSummary, 'sources' | 'path'>, now: Date): string {
  const sources = summary.sources.length === 1 && summary.sources[0] ? IMPORT_SOURCE_NAMES[summary.sources[0]] : 'Chat';
  const mixed = summary.sources.length > 1;
  const messages = entries.reduce((sum, entry) => sum + entry.messages, 0);
  const sorted = [...entries].sort((a, b) => (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity));
  const parts = [
    `# ${sources} history`,
    [`- Conversations: ${count(entries.length)}`, `- Messages: ${count(messages)}`, `- Imported: ${formatDateTime(now)} from \`${summary.path.replace(/`/g, '')}\``].join('\n'),
  ];
  let group = '';
  let lines: string[] = [];
  const flush = () => {
    if (lines.length) parts.push(`## ${group}`, lines.join('\n'));
    lines = [];
  };
  for (const entry of sorted) {
    const month = entry.date ? formatDate(entry.date).slice(0, 7) : 'Undated';
    if (month !== group) {
      flush();
      group = month;
    }
    const link = `[${escapeMarkdown(entry.title).replace(/\s+/g, ' ')}](${linkTarget(entry.file)})`;
    const details = [entry.date ? formatDate(entry.date) : null, link, mixed ? IMPORT_SOURCE_NAMES[entry.source] : null, `${count(entry.messages)} ${entry.messages === 1 ? 'message' : 'messages'}`];
    lines.push(`- ${details.filter(Boolean).join(' · ')}`);
  }
  flush();
  return `${parts.join('\n\n')}\n`;
}

/** A relative link that works in Obsidian, GitHub and plain Markdown viewers. */
function linkTarget(file: string): string {
  return encodeURIComponent(file).replace(/[()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** "ChatGPT history 2026-09-28.zip", or "Chat history …" when the export has several sources. */
export function historyZipName(sources: readonly ImportSource[], now: Date): string {
  const name = sources.length === 1 && sources[0] ? IMPORT_SOURCE_NAMES[sources[0]] : 'Chat';
  return `${name} history ${formatDate(now)}.zip`;
}

const NUMBER = new Intl.NumberFormat('en-US');

function count(value: number): string {
  return NUMBER.format(value);
}
