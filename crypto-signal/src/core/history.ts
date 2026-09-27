import { isValidSymbol } from './assets';
import type { Explanation } from './explain';
import { asObject, sanitizeAnalysis, sanitizeExplanation } from './sanitize';
import type { Analysis } from './signal';
import { isFiniteNumber, isInterval, isProviderId, type Interval, type ProviderId } from './types';

/**
 * A saved analysis. Reopening one shows exactly what was shown then (a dated snapshot),
 * never refreshed values.
 */
export interface HistoryEntry {
  id: string;
  /** When the market data was fetched. */
  fetchedAt: number;
  symbol: string;
  name: string;
  quote: string;
  interval: Interval;
  source: ProviderId;
  price: number;
  changePct24h: number | null;
  analysis: Analysis;
  explanation: Explanation;
}

/** A newer analysis of the same market within this window replaces the newest entry instead of stacking up. */
export const HISTORY_MERGE_WINDOW_MS = 5 * 60 * 1000;

/** Newest first, capped at `max`. */
export function addToHistory(items: readonly HistoryEntry[], entry: HistoryEntry, max: number): HistoryEntry[] {
  if (max <= 0) return [];
  const [newest, ...rest] = items;
  const replaceNewest =
    newest !== undefined &&
    newest.symbol === entry.symbol &&
    newest.interval === entry.interval &&
    entry.fetchedAt >= newest.fetchedAt &&
    entry.fetchedAt - newest.fetchedAt < HISTORY_MERGE_WINDOW_MS;
  const others = (replaceNewest ? rest : items).filter((item) => item.id !== entry.id);
  return [entry, ...others].slice(0, max);
}

export function removeFromHistory(items: readonly HistoryEntry[], id: string): HistoryEntry[] {
  return items.filter((item) => item.id !== id);
}

/** Drops anything malformed read back from storage. */
export function sanitizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: HistoryEntry[] = [];
  for (const value of raw) {
    const entry = sanitizeHistoryEntry(value);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function sanitizeHistoryEntry(raw: unknown): HistoryEntry | null {
  const e = asObject(raw);
  if (!e) return null;
  if (typeof e.id !== 'string' || !e.id || !isFiniteNumber(e.fetchedAt) || !isValidSymbol(e.symbol)) return null;
  if (typeof e.name !== 'string' || typeof e.quote !== 'string' || !isInterval(e.interval) || !isProviderId(e.source)) return null;
  if (!isFiniteNumber(e.price) || e.price <= 0) return null;
  if (e.changePct24h !== null && !isFiniteNumber(e.changePct24h)) return null;
  const analysis = sanitizeAnalysis(e.analysis);
  const explanation = sanitizeExplanation(e.explanation);
  if (!analysis || !explanation) return null;
  return {
    id: e.id,
    fetchedAt: e.fetchedAt,
    symbol: e.symbol,
    name: e.name.slice(0, 40),
    quote: e.quote.slice(0, 10),
    interval: e.interval,
    source: e.source,
    price: e.price,
    changePct24h: e.changePct24h as number | null,
    analysis,
    explanation,
  };
}
