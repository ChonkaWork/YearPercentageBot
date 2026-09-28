/**
 * Usage stats: how often each snippet was inserted (expanded, picked from the suggestions,
 * copied from the popup) and when it was last used. Kept per snippet id, in this browser only.
 * Pure functions.
 */

import { sortSnippets, type Snippet } from './snippets';

export interface UsageEntry {
  count: number;
  /** Epoch milliseconds. */
  lastUsed: number;
}

export type UsageMap = Readonly<Record<string, UsageEntry>>;

/** No snippet library has more ids than this; anything beyond is junk. */
const MAX_ENTRIES = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whatever is in storage becomes a valid map: bad entries are dropped. */
export function sanitizeUsage(raw: unknown): Record<string, UsageEntry> {
  const usage: Record<string, UsageEntry> = {};
  if (!isRecord(raw)) return usage;
  let size = 0;
  for (const [id, entry] of Object.entries(raw)) {
    if (size >= MAX_ENTRIES) break;
    if (!id || id.length > 64 || !isRecord(entry)) continue;
    const count = entry.count;
    const lastUsed = entry.lastUsed;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) continue;
    if (typeof lastUsed !== 'number' || !Number.isFinite(lastUsed) || lastUsed < 0) continue;
    usage[id] = { count, lastUsed };
    size++;
  }
  return usage;
}

/** One more use of `id` at `now`. Entries of snippets that no longer exist (`ids`) are dropped. */
export function recordUse(usage: UsageMap, id: string, now: number, ids?: ReadonlySet<string>): Record<string, UsageEntry> {
  const next: Record<string, UsageEntry> = {};
  for (const [key, entry] of Object.entries(usage)) if (!ids || ids.has(key)) next[key] = entry;
  const current = usage[id];
  next[id] = { count: Math.min((current?.count ?? 0) + 1, Number.MAX_SAFE_INTEGER), lastUsed: Math.max(now, current?.lastUsed ?? 0) };
  return next;
}

// --- Sorting ----------------------------------------------------------------------------

export const SORT_ORDERS = ['used', 'az', 'recent'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export function isSortOrder(value: unknown): value is SortOrder {
  return typeof value === 'string' && (SORT_ORDERS as readonly string[]).includes(value);
}

export const SORT_LABELS: Readonly<Record<SortOrder, string>> = { used: 'Most used', az: 'A–Z', recent: 'Recent' };

/**
 * `used`: most uses first, then the most recently used. `recent`: most recently used first;
 * snippets never used follow, newest edits first. Ties (and `az`) are alphabetical by
 * abbreviation.
 */
export function sortByOrder(snippets: readonly Snippet[], order: SortOrder, usage: UsageMap): Snippet[] {
  const alphabetical = sortSnippets(snippets);
  if (order === 'az') return alphabetical;
  const rank = new Map(alphabetical.map((snippet, index) => [snippet.id, index]));
  const count = (snippet: Snippet) => usage[snippet.id]?.count ?? 0;
  const last = (snippet: Snippet) => usage[snippet.id]?.lastUsed ?? 0;
  const byName = (a: Snippet, b: Snippet) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  if (order === 'used') return alphabetical.sort((a, b) => count(b) - count(a) || last(b) - last(a) || byName(a, b));
  return alphabetical.sort((a, b) => last(b) - last(a) || (last(a) === 0 ? b.updatedAt - a.updatedAt : 0) || byName(a, b));
}

// --- Display ----------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "3 weeks ago", "2 months ago", "a year ago". */
export function relativeTime(then: number, now: number): string {
  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}

/** "used 34× · 2 days ago", or null when the snippet was never used. */
export function formatUsage(entry: UsageEntry | undefined, now: number): string | null {
  if (!entry) return null;
  return `used ${entry.count.toLocaleString('en-US')}× · ${relativeTime(entry.lastUsed, now)}`;
}

/** Longer form for tooltips and screen readers: "Used 34 times, last 2 days ago". */
export function describeUsage(entry: UsageEntry | undefined, now: number): string {
  if (!entry) return 'Not used yet';
  const times = entry.count === 1 ? 'once' : `${entry.count.toLocaleString('en-US')} times`;
  return `Used ${times}, last ${relativeTime(entry.lastUsed, now)}`;
}
