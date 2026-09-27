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
}

export interface NewHistoryEntry {
  action: PromptAction;
  prompt: string;
  page?: PageContext | null;
  sourceText?: string;
}

const PREVIEW_CHARS = 120;

export function createHistoryItem(entry: NewHistoryEntry, id: string, timestamp: number): HistoryItem {
  const item: HistoryItem = { id, timestamp, action: entry.action, prompt: entry.prompt };
  if (entry.page?.title) item.pageTitle = entry.page.title;
  if (entry.page?.url) item.pageUrl = entry.page.url;
  const preview = previewOf(entry.sourceText ?? '');
  if (preview) item.preview = preview;
  return item;
}

export function previewOf(text: string): string {
  const flat = text.slice(0, PREVIEW_CHARS * 4).replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : flat;
}

/** Newest first, capped at `max`. */
export function addToHistory(items: readonly HistoryItem[], item: HistoryItem, max: number): HistoryItem[] {
  if (max <= 0) return [];
  return [item, ...items.filter((existing) => existing.id !== item.id)].slice(0, max);
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
    items.push(item);
  }
  return items;
}
