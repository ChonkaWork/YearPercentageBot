import { actionLabel } from '../templates';
import { isPromptAction, type PageContext, type PromptAction } from './types';

export interface HistoryItem {
  id: string;
  timestamp: number;
  action: PromptAction;
  prompt: string;
  pageTitle?: string;
  pageUrl?: string;
  /** First words of the source text, for the history list. */
  preview?: string;
  /** Name of the custom template that made it (action is then `custom`). */
  templateName?: string;
  /** Pinned items stay on top and are never rotated out by the history size. */
  pinned?: true;
}

export interface NewHistoryEntry {
  action: PromptAction;
  prompt: string;
  page?: PageContext | null;
  sourceText?: string;
  templateName?: string;
}

const PREVIEW_CHARS = 120;

export function createHistoryItem(entry: NewHistoryEntry, id: string, timestamp: number): HistoryItem {
  const item: HistoryItem = { id, timestamp, action: entry.action, prompt: entry.prompt };
  if (entry.page?.title) item.pageTitle = entry.page.title;
  if (entry.page?.url) item.pageUrl = entry.page.url;
  const preview = previewOf(entry.sourceText ?? '');
  if (preview) item.preview = preview;
  if (entry.templateName) item.templateName = entry.templateName;
  return item;
}

export function previewOf(text: string): string {
  const flat = text.slice(0, PREVIEW_CHARS * 4).replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : flat;
}

/** Newest first, capped at `max`. Pinned items are never dropped; the new item always stays. */
export function addToHistory(items: readonly HistoryItem[], item: HistoryItem, max: number): HistoryItem[] {
  const rest = items.filter((existing) => existing.id !== item.id);
  if (max <= 0) return trimHistory(rest, 0);
  const pinned = rest.filter((existing) => existing.pinned).length;
  return trimHistory([item, ...rest], Math.max(max, pinned + 1));
}

/** Keeps at most `max` items, dropping the oldest unpinned ones first. Pinned items always stay. */
export function trimHistory(items: readonly HistoryItem[], max: number): HistoryItem[] {
  let unpinnedLeft = Math.max(0, max - items.filter((item) => item.pinned).length);
  return items.filter((item) => item.pinned || unpinnedLeft-- > 0);
}

export function setPinned(items: readonly HistoryItem[], id: string, pinned: boolean): HistoryItem[] {
  return items.map((item) => {
    if (item.id !== id) return item;
    const { pinned: _was, ...rest } = item;
    return pinned ? { ...rest, pinned: true } : rest;
  });
}

/** "Clear all" keeps pinned prompts: only an explicit unpin or delete removes them. */
export function clearUnpinned(items: readonly HistoryItem[]): HistoryItem[] {
  return items.filter((item) => item.pinned);
}

/** Pinned first, then the rest; each group keeps its (newest first) order. */
export function orderForDisplay(items: readonly HistoryItem[]): HistoryItem[] {
  return [...items.filter((item) => item.pinned), ...items.filter((item) => !item.pinned)];
}

/**
 * Case-insensitive search. Every word of the query must appear somewhere in the item: the
 * prompt, the page title or URL, the source preview, or the action / template name.
 */
export function searchHistory(items: readonly HistoryItem[], query: string): HistoryItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = [item.prompt, item.pageTitle, item.pageUrl, item.preview, item.templateName ?? actionLabel(item.action)]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function removeFromHistory(items: readonly HistoryItem[], id: string): HistoryItem[] {
  return items.filter((item) => item.id !== id);
}

export function replacePrompt(items: readonly HistoryItem[], id: string, prompt: string): HistoryItem[] {
  return items.map((item) => (item.id === id ? { ...item, prompt } : item));
}

/** Drops anything malformed read back from storage. */
export function sanitizeHistory(raw: unknown): HistoryItem[] {
  if (!Array.isArray(raw)) return [];
  const items: HistoryItem[] = [];
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.id !== 'string' ||
      typeof entry.timestamp !== 'number' ||
      typeof entry.prompt !== 'string' ||
      !isPromptAction(entry.action)
    ) {
      continue;
    }
    const item: HistoryItem = { id: entry.id, timestamp: entry.timestamp, action: entry.action, prompt: entry.prompt };
    if (typeof entry.pageTitle === 'string') item.pageTitle = entry.pageTitle;
    if (typeof entry.pageUrl === 'string') item.pageUrl = entry.pageUrl;
    if (typeof entry.preview === 'string') item.preview = entry.preview;
    if (typeof entry.templateName === 'string' && entry.templateName) item.templateName = entry.templateName;
    if (entry.pinned === true) item.pinned = true;
    items.push(item);
  }
  return items;
}
