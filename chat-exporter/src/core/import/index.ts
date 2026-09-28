import { isChatGptConversation, parseChatGptConversation } from './chatgpt';
import { isClaudeConversation, parseClaudeConversation } from './claude';
import { JsonArrayError, JsonArraySplitter } from './jsonArray';
import { addSkips, emptySkips, type ImportedConversation, type ImportSource, type ParsedConversation, type SkippedMessages } from './types';
import { DEFAULT_ZIP_LIMITS, formatBytes, looksLikeZip, openZipEntry, readZipDirectory, ZipError, type ZipEntry, type ZipLimits } from './zip';

/**
 * History import: reads the data export that ChatGPT or Claude email to their users (a zip, or
 * the `conversations.json` inside it) and yields one normalized conversation at a time.
 *
 * Self-contained on purpose (only this folder, only standard web APIs, no Chrome APIs): other
 * extensions copy the whole folder. Nothing is uploaded; the file is read where it was dropped.
 *
 *   const summary = await importHistory(file, { onConversation: (c) => …, onProgress: (p) => … });
 *
 * - Only `conversations.json` is read from the zip (at any folder depth); images and other files
 *   are never inflated. Zip bombs are capped (entry count, uncompressed size, CRC check).
 * - The JSON is parsed one conversation at a time, so large histories don't need one giant string.
 * - Which export it is comes from each conversation's shape (`mapping` → ChatGPT, `chat_messages`
 *   → Claude), not from the file name.
 */

export * from './types';
export { baseName, crc32, formatBytes, ZipError, ZipWriter } from './zip';

export type ImportErrorCode =
  | 'NOT_EXPORT'
  | 'NO_CONVERSATIONS_JSON'
  | 'BAD_ZIP'
  | 'TOO_LARGE'
  | 'NOT_JSON'
  | 'NOT_A_LIST'
  | 'NO_CONVERSATIONS'
  | 'UNKNOWN_FORMAT'
  | 'ABORTED';

const WHERE_TO_GET_IT = 'Use the zip from ChatGPT (Settings → Data controls → Export data) or Claude (Settings → Privacy → Export data).';

export const IMPORT_ERROR_MESSAGES: Readonly<Record<ImportErrorCode, string>> = {
  NOT_EXPORT: `This isn't a zip or a JSON file. ${WHERE_TO_GET_IT}`,
  NO_CONVERSATIONS_JSON: `This zip has no conversations.json. ${WHERE_TO_GET_IT}`,
  BAD_ZIP: "This zip can't be read. It may be damaged or still downloading: download the export again.",
  TOO_LARGE: 'This export is too large to read in the browser.',
  NOT_JSON: "conversations.json isn't valid JSON. It may be damaged: download the export again.",
  NOT_A_LIST: "conversations.json isn't a list of conversations, so it isn't a ChatGPT or Claude export.",
  NO_CONVERSATIONS: 'This export has no conversations.',
  UNKNOWN_FORMAT: "No ChatGPT or Claude conversations were found in this file. If it is a recent export, its format may have changed.",
  ABORTED: 'Import cancelled.',
};

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string = IMPORT_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportProgress {
  /** Conversations converted so far. */
  conversations: number;
  /** Bytes of the input read so far (compressed bytes for a zip). */
  bytesRead: number;
  /** Bytes that will be read in total. */
  totalBytes: number;
}

export interface ImportOptions {
  /** Called for every conversation, in file order. Awaited, so it can write output as it goes. */
  onConversation(conversation: ImportedConversation): void | Promise<void>;
  onProgress?(progress: ImportProgress): void;
  signal?: AbortSignal;
  limits?: Partial<ZipLimits>;
}

export interface ImportSummary {
  /** The exports found (usually one). */
  sources: ImportSource[];
  conversations: number;
  messages: number;
  skippedMessages: SkippedMessages;
  skippedConversations: {
    /** Elements that are neither a ChatGPT nor a Claude conversation. */
    unrecognized: number;
    /** Conversations without a single message to keep. */
    empty: number;
  };
  /** Where the conversations came from: "conversations.json" or "Export/conversations.json". */
  path: string;
}

const CONVERSATIONS_JSON = 'conversations.json';

export async function importHistory(file: Blob, options: ImportOptions): Promise<ImportSummary> {
  const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...options.limits };
  const abortIfNeeded = () => {
    if (options.signal?.aborted) throw new ImportError('ABORTED');
  };
  abortIfNeeded();

  let stream: ReadableStream<Uint8Array>;
  let bytesRead: () => number;
  let totalBytes: number;
  let path = CONVERSATIONS_JSON;
  try {
    if (await looksLikeZip(file)) {
      const entry = findConversationsJson(await readZipDirectory(file, limits));
      if (!entry) throw new ImportError('NO_CONVERSATIONS_JSON');
      path = entry.name;
      const opened = await openZipEntry(file, entry, limits);
      stream = opened.stream;
      bytesRead = opened.bytesRead;
      totalBytes = entry.compressedSize;
    } else {
      if (!(await looksLikeJson(file))) throw new ImportError('NOT_EXPORT');
      if (file.size > limits.maxEntryBytes) {
        throw new ImportError('TOO_LARGE', `This file is ${formatBytes(file.size)}, more than the ${formatBytes(limits.maxEntryBytes)} that can be read.`);
      }
      let read = 0;
      stream = file.stream().pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            read += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
      bytesRead = () => read;
      totalBytes = file.size;
    }
  } catch (error) {
    throw toImportError(error);
  }

  const summary: ImportSummary = {
    sources: [],
    conversations: 0,
    messages: 0,
    skippedMessages: emptySkips(),
    skippedConversations: { unrecognized: 0, empty: 0 },
    path,
  };
  let elements = 0;
  /** Errors of the caller's own callback pass through unchanged. */
  let consumerError: unknown = null;
  const splitter = new JsonArraySplitter();
  const reader = stream.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();

  const handle = async (text: string) => {
    elements++;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ImportError('NOT_JSON');
    }
    const parsed = parseConversation(raw);
    if (!parsed) {
      summary.skippedConversations.unrecognized++;
      return;
    }
    addSkips(summary.skippedMessages, parsed.skipped);
    const conversation = parsed.conversation;
    if (!conversation) {
      summary.skippedConversations.empty++;
      return;
    }
    if (!summary.sources.includes(conversation.source)) summary.sources.push(conversation.source);
    summary.conversations++;
    summary.messages += conversation.messages.length;
    try {
      await options.onConversation(conversation);
    } catch (error) {
      consumerError = error;
      throw error;
    }
  };

  try {
    for (;;) {
      abortIfNeeded();
      const { value, done } = await reader.read();
      if (done) {
        splitter.end();
        break;
      }
      for (const text of splitter.push(value)) {
        abortIfNeeded();
        await handle(text);
      }
      options.onProgress?.({ conversations: summary.conversations, bytesRead: bytesRead(), totalBytes });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (consumerError !== null && error === consumerError) throw error;
    throw toImportError(error);
  }

  options.onProgress?.({ conversations: summary.conversations, bytesRead: totalBytes, totalBytes });
  if (elements === 0) throw new ImportError('NO_CONVERSATIONS');
  if (summary.conversations === 0 && summary.skippedConversations.unrecognized > 0) throw new ImportError('UNKNOWN_FORMAT');
  return summary;
}

/** Detects the export from the shape of one element of conversations.json. */
export function parseConversation(raw: unknown): ParsedConversation | null {
  if (isChatGptConversation(raw)) return parseChatGptConversation(raw);
  if (isClaudeConversation(raw)) return parseClaudeConversation(raw);
  return null;
}

/** conversations.json at any depth, the shallowest first; macOS resource forks are ignored. */
export function findConversationsJson(entries: readonly ZipEntry[]): ZipEntry | null {
  const candidates = entries.filter((entry) => {
    const segments = entry.name.split('/');
    const name = segments[segments.length - 1] ?? '';
    return name.toLowerCase() === CONVERSATIONS_JSON && !segments.includes('__MACOSX') && entry.size > 0;
  });
  candidates.sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.localeCompare(b.name));
  return candidates[0] ?? null;
}

async function looksLikeJson(file: Blob): Promise<boolean> {
  const head = new TextDecoder().decode(await file.slice(0, 64).arrayBuffer());
  return /^﻿?\s*[[{]/.test(head);
}

function toImportError(error: unknown): ImportError {
  if (error instanceof ImportError) return error;
  if (error instanceof ZipError) {
    if (error.code === 'NOT_ZIP' || error.code === 'CORRUPT') return new ImportError('BAD_ZIP', error.code === 'CORRUPT' ? error.message : IMPORT_ERROR_MESSAGES.BAD_ZIP);
    if (error.code === 'TOO_LARGE' || error.code === 'TOO_MANY_ENTRIES') return new ImportError('TOO_LARGE', error.message);
    return new ImportError('BAD_ZIP', error.message);
  }
  if (error instanceof JsonArrayError) {
    if (error.code === 'NOT_ARRAY') return new ImportError('NOT_A_LIST');
    if (error.code === 'EMPTY') return new ImportError('NO_CONVERSATIONS');
    return new ImportError('NOT_JSON');
  }
  if (error instanceof RangeError) return new ImportError('TOO_LARGE');
  // DecompressionStream reports damaged deflate data as a TypeError.
  if (error instanceof TypeError) return new ImportError('BAD_ZIP');
  return new ImportError('NOT_JSON', `Couldn't read the export: ${error instanceof Error ? error.message : String(error)}`);
}
